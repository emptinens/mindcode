//! Integration tests for `mindcode-transport` against the in-process mock.

mod common;

use common::{MockRoutes, MockServer, TEST_API_KEY};
use futures_util::StreamExt;
use mindcode_provider::{Protocol, SecretKey};
use mindcode_transport::{
    ChatChunk, ChatCompletionsRequest, ChatMessage, HttpFailureKind, MessageChunk, MessagesRequest,
    ModelCatalog, Transport, TransportError,
};

fn test_key() -> SecretKey {
    SecretKey::new(TEST_API_KEY.to_owned())
}

fn chat_request(model: &str) -> ChatCompletionsRequest {
    ChatCompletionsRequest {
        model: model.to_owned(),
        messages: vec![ChatMessage {
            role: "user".to_owned(),
            content: "ping".to_owned(),
            ..Default::default()
        }],
        max_tokens: Some(16),
        temperature: None,
        tools: Vec::new(),
        reasoning_effort: None,
    }
}

fn messages_request(model: &str) -> MessagesRequest {
    MessagesRequest {
        model: model.to_owned(),
        max_tokens: 16,
        messages: vec![ChatMessage {
            role: "user".to_owned(),
            content: "ping".to_owned(),
            ..Default::default()
        }],
        system: None,
        temperature: None,
        tools: Vec::new(),
        reasoning_effort: None,
    }
}

#[tokio::test]
async fn catalog_fetch_success_projects_typed_rows() {
    let server = MockServer::start(MockRoutes::default()).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let catalog: ModelCatalog = transport.fetch_catalog(&test_key()).await.unwrap();
    assert_eq!(catalog.object, "list");
    let ids = catalog
        .data
        .iter()
        .map(|row| row.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["model-alpha", "model-beta", "model-gamma"]);
    assert_eq!(catalog.data[1].owned_by.as_deref(), Some("tests"));

    let raw = transport.fetch_catalog_value(&test_key()).await.unwrap();
    assert_eq!(raw["data"][1]["owned_by"], "tests");

    let model_ids = transport.fetch_model_ids(&test_key()).await.unwrap();
    let model_ids = model_ids.iter().map(|id| id.as_str()).collect::<Vec<_>>();
    assert_eq!(model_ids, ["model-alpha", "model-beta", "model-gamma"]);
    server.shutdown().await;
}

#[tokio::test]
async fn transient_catalog_failure_retries_then_succeeds() {
    let routes = MockRoutes {
        models_status_sequence: vec![429, 200],
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let catalog = transport.fetch_catalog(&test_key()).await.unwrap();
    assert_eq!(catalog.data.len(), 3);
    assert_eq!(server.authorization_headers().len(), 2);
    server.shutdown().await;
}

#[tokio::test]
async fn transient_stream_failure_retries_before_first_event() {
    let routes = MockRoutes {
        chat_status_sequence: vec![503, 200],
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let chunks: Vec<_> = transport
        .chat_completions(&test_key(), &chat_request("model-alpha"))
        .unwrap()
        .collect()
        .await;
    assert_eq!(chunks.len(), 4);
    assert_eq!(server.authorization_headers().len(), 2);
    server.shutdown().await;
}

#[tokio::test]
async fn catalog_fetch_on_http_400_fails_closed() {
    let routes = MockRoutes {
        models_status: 400,
        models_body: br#"{"error":{"message":"catalog marker"}}"#.to_vec(),
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let error = transport.fetch_catalog(&test_key()).await.unwrap_err();
    assert!(matches!(
        error,
        TransportError::Http {
            status: 400,
            kind: HttpFailureKind::ClientError
        }
    ));
    assert!(!error.to_string().contains("catalog marker"));
    server.shutdown().await;
}

#[tokio::test]
async fn catalog_fetch_on_invalid_json_fails_closed() {
    let routes = MockRoutes {
        models_body: b"this is not json".to_vec(),
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let error = transport.fetch_catalog(&test_key()).await.unwrap_err();
    assert_eq!(error, TransportError::InvalidJson);
    assert!(!error.to_string().contains("this is not json"));
    server.shutdown().await;
}

#[tokio::test]
async fn chat_completions_stream_yields_all_chunks_then_ends() {
    let server = MockServer::start(MockRoutes::default()).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let stream = transport
        .chat_completions(&test_key(), &chat_request("model-alpha"))
        .unwrap();
    let chunks: Vec<ChatChunk> = stream.map(|item| item.unwrap()).collect().await;
    assert_eq!(chunks.len(), 4);
    assert_eq!(
        chunks[0].choices[0].delta.role.as_deref(),
        Some("assistant")
    );
    let text: String = chunks
        .iter()
        .filter_map(|chunk| chunk.choices[0].delta.content.as_ref().cloned())
        .collect();
    assert_eq!(text, "Hello world");
    assert_eq!(chunks[3].choices[0].finish_reason.as_deref(), Some("stop"));
    server.shutdown().await;
}

#[tokio::test]
async fn messages_stream_yields_events_then_ends() {
    let server = MockServer::start(MockRoutes::default()).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let stream = transport
        .messages(&test_key(), &messages_request("model-alpha"))
        .unwrap();
    let events: Vec<MessageChunk> = stream.map(|item| item.unwrap()).collect().await;
    assert_eq!(events.len(), 5);
    assert_eq!(events[0].r#type, "message_start");
    assert_eq!(events[0].message.as_ref().unwrap().id, "msg_1");
    assert_eq!(events[1].r#type, "content_block_start");
    let text: String = events
        .iter()
        .filter_map(|event| {
            event
                .delta
                .as_ref()
                .and_then(|delta| delta.text.as_ref())
                .cloned()
        })
        .collect();
    assert_eq!(text, "Hello world");
    assert_eq!(events[4].r#type, "message_delta");
    server.shutdown().await;
}

#[tokio::test]
async fn authorization_header_carries_bearer_test_key() {
    let server = MockServer::start(MockRoutes::default()).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let _catalog = transport.fetch_catalog(&test_key()).await.unwrap();
    let stream = transport
        .chat_completions(&test_key(), &chat_request("model-alpha"))
        .unwrap();
    let chunks: Vec<_> = stream.collect().await;
    assert_eq!(chunks.len(), 4);

    let expected = format!("Bearer {TEST_API_KEY}");
    assert_eq!(server.last_authorization(), Some(expected));
    assert!(server
        .authorization_headers()
        .iter()
        .all(|header| header == &format!("Bearer {TEST_API_KEY}")));
    server.shutdown().await;
}

#[tokio::test]
async fn chat_completions_on_http_401_fails_closed() {
    let routes = MockRoutes {
        chat_status: 401,
        chat_events: vec![
            r#"{"error":{"message":"bad key marker"}}"#.to_owned(),
            "[DONE]".to_owned(),
        ],
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let items: Vec<_> = transport
        .chat_completions(&test_key(), &chat_request("model-alpha"))
        .unwrap()
        .collect()
        .await;
    assert_eq!(items.len(), 1);
    let error = items[0].as_ref().unwrap_err();
    assert!(matches!(
        error,
        TransportError::Http {
            status: 401,
            kind: HttpFailureKind::Unauthorized
        }
    ));
    assert!(!error.to_string().contains("bad key marker"));
    server.shutdown().await;
}

#[tokio::test]
async fn invalid_stream_json_fails_closed_without_panic() {
    let routes = MockRoutes {
        chat_events: vec!["not valid json".to_owned(), "[DONE]".to_owned()],
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let items: Vec<_> = transport
        .chat_completions(&test_key(), &chat_request("model-alpha"))
        .unwrap()
        .collect()
        .await;
    assert_eq!(items.len(), 1);
    assert!(matches!(items[0], Err(TransportError::InvalidJson)));
    server.shutdown().await;
}

#[tokio::test]
async fn oversized_responses_are_bounded_errors() {
    let routes = MockRoutes {
        oversized: true,
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let catalog_error = transport.fetch_catalog(&test_key()).await.unwrap_err();
    assert!(matches!(
        catalog_error,
        TransportError::ResponseTooLarge { .. }
    ));

    let items: Vec<_> = transport
        .chat_completions(&test_key(), &chat_request("model-alpha"))
        .unwrap()
        .collect()
        .await;
    assert_eq!(items.len(), 1);
    assert!(matches!(
        items[0],
        Err(TransportError::ResponseTooLarge { .. })
    ));
    server.shutdown().await;
}

#[tokio::test]
async fn anthropic_catalog_fetch_parses_model_ids() {
    let server = MockServer::start(MockRoutes::default()).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let ids = transport.fetch_anthropic_models(&test_key()).await.unwrap();
    let ids = ids.iter().map(|id| id.as_str()).collect::<Vec<_>>();
    assert_eq!(ids, ["claude-sonnet-4-5", "claude-haiku-4-5"]);

    let dispatched = transport
        .fetch_provider_model_ids(&Protocol::AnthropicCompatible, &test_key())
        .await
        .unwrap();
    let dispatched = dispatched.iter().map(|id| id.as_str()).collect::<Vec<_>>();
    assert_eq!(dispatched, ids);

    server.shutdown().await;
}

#[tokio::test]
async fn provider_model_ids_dispatches_openai_path() {
    let server = MockServer::start(MockRoutes::default()).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let ids = transport
        .fetch_provider_model_ids(&Protocol::OpenAiCompatible, &test_key())
        .await
        .unwrap();
    let ids = ids.iter().map(|id| id.as_str()).collect::<Vec<_>>();
    assert_eq!(ids, ["model-alpha", "model-beta", "model-gamma"]);
    server.shutdown().await;
}

#[tokio::test]
async fn anthropic_catalog_fetch_carries_bearer_header() {
    let server = MockServer::start(MockRoutes::default()).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let _ = transport.fetch_anthropic_models(&test_key()).await.unwrap();
    assert_eq!(
        server.last_authorization(),
        Some(format!("Bearer {TEST_API_KEY}"))
    );
    server.shutdown().await;
}

#[tokio::test]
async fn anthropic_catalog_on_http_400_fails_closed() {
    let routes = MockRoutes {
        v1_models_status: 400,
        v1_models_body: br#"{"type":"error","error":{"message":"anthropic marker"}}"#.to_vec(),
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let error = transport
        .fetch_anthropic_models(&test_key())
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        TransportError::Http {
            status: 400,
            kind: HttpFailureKind::ClientError
        }
    ));
    assert!(!error.to_string().contains("anthropic marker"));
    server.shutdown().await;
}

#[tokio::test]
async fn anthropic_catalog_on_invalid_json_fails_closed() {
    let routes = MockRoutes {
        v1_models_body: b"this is not json".to_vec(),
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let error = transport
        .fetch_anthropic_models(&test_key())
        .await
        .unwrap_err();
    assert_eq!(error, TransportError::InvalidJson);
    assert!(!error.to_string().contains("this is not json"));
    server.shutdown().await;
}

#[tokio::test]
async fn anthropic_catalog_on_malformed_rows_fails_closed() {
    for body in [
        br#"{"data":[{"type":"model","created_at":"2025-07-01T00:00:00.000Z","display_name":"Missing id"}],"has_more":false}"#.to_vec(),
        br#"{"data":[{"id":"a","type":"model","created_at":"2025-07-01T00:00:00.000Z","display_name":"A","extra":1}],"has_more":false}"#.to_vec(),
        br#"{"data":[{"id":"a","type":"model","created_at":"2025-07-01T00:00:00.000Z","display_name":"A"},{"id":"a","type":"model","created_at":"2025-07-01T00:00:00.000Z","display_name":"A duplicate"}],"has_more":false}"#.to_vec(),
    ] {
        let routes = MockRoutes {
            v1_models_body: body,
            ..Default::default()
        };
        let server = MockServer::start(routes).await;
        let transport = Transport::new(&server.base_url()).unwrap();
        let error = transport
            .fetch_anthropic_models(&test_key())
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                TransportError::InvalidJson | TransportError::InvalidCatalog { .. }
            ),
            "expected a closed failure, got {error:?}"
        );
        server.shutdown().await;
    }
}

#[tokio::test]
async fn anthropic_catalog_oversized_body_fails_closed() {
    let routes = MockRoutes {
        oversized: true,
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let error = transport
        .fetch_anthropic_models(&test_key())
        .await
        .unwrap_err();
    assert!(matches!(error, TransportError::ResponseTooLarge { .. }));
    server.shutdown().await;
}

#[tokio::test]
async fn chat_stream_parses_streamed_tool_call_deltas() {
    let routes = MockRoutes {
        chat_events: vec![
            r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]},"finish_reason":null}]}"#.to_owned(),
            r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"src/a.txt\"}"}}]},"finish_reason":null}]}"#.to_owned(),
            r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#.to_owned(),
            "[DONE]".to_owned(),
        ],
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let chunks: Vec<ChatChunk> = transport
        .chat_completions(&test_key(), &chat_request("model-alpha"))
        .unwrap()
        .map(|item| item.unwrap())
        .collect()
        .await;

    let name = chunks[0].choices[0].delta.tool_calls[0]
        .function
        .as_ref()
        .unwrap()
        .name
        .clone();
    assert_eq!(name.as_deref(), Some("read_file"));
    assert_eq!(
        chunks[0].choices[0].delta.tool_calls[0].id.as_deref(),
        Some("call_1")
    );
    // Arguments fragments concatenate across chunks by index.
    let arguments: String = chunks
        .iter()
        .flat_map(|chunk| &chunk.choices[0].delta.tool_calls)
        .filter_map(|call| call.function.as_ref())
        .filter_map(|function| function.arguments.as_deref())
        .collect();
    assert_eq!(arguments, "{\"path\":\"src/a.txt\"}");
    server.shutdown().await;
}

#[tokio::test]
async fn messages_stream_parses_tool_use_blocks() {
    let routes = MockRoutes {
        messages_events: vec![
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}"#.to_owned(),
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"src/a.txt\"}"}}"#.to_owned(),
            r#"{"type":"content_block_stop","index":0}"#.to_owned(),
            r#"{"type":"message_stop"}"#.to_owned(),
        ],
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let events: Vec<MessageChunk> = transport
        .messages(&test_key(), &messages_request("model-alpha"))
        .unwrap()
        .map(|item| item.unwrap())
        .collect()
        .await;

    assert_eq!(events.len(), 3);
    let block = events[0].content_block.as_ref().unwrap();
    assert_eq!(block.r#type, "tool_use");
    assert_eq!(block.name.as_deref(), Some("read_file"));
    assert_eq!(block.id.as_deref(), Some("toolu_1"));
    assert_eq!(
        events[1].delta.as_ref().unwrap().partial_json.as_deref(),
        Some("{\"path\":\"src/a.txt\"}")
    );
    server.shutdown().await;
}

#[tokio::test]
async fn errors_never_echo_key_or_response_body() {
    let routes = MockRoutes {
        models_status: 400,
        models_body: br#"{"error":{"message":"secret-marker-xyz"}}"#.to_vec(),
        chat_status: 401,
        ..Default::default()
    };
    let server = MockServer::start(routes).await;
    let transport = Transport::new(&server.base_url()).unwrap();

    let http_error = transport.fetch_catalog(&test_key()).await.unwrap_err();
    let stream_items: Vec<_> = transport
        .chat_completions(&test_key(), &chat_request("model-alpha"))
        .unwrap()
        .collect()
        .await;
    let stream_error = stream_items[0].as_ref().unwrap_err();

    for error in [http_error, stream_error.clone()] {
        let display = error.to_string();
        let debug = format!("{error:?}");
        for output in [&display, &debug] {
            assert!(!output.contains(TEST_API_KEY), "leaked key: {output}");
            assert!(
                !output.contains("secret-marker-xyz"),
                "echoed body: {output}"
            );
        }
    }
    server.shutdown().await;
}

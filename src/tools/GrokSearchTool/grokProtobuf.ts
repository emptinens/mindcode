// Minimal protobuf + gRPC framing helpers for the Grok chat API.
// We only implement the wire pieces we actually use.

export type WireField = {
	tag: number;
	wire: number;
	value: bigint | Uint8Array;
};

// ---- varint ----
export function encodeVarint(n: number | bigint): Uint8Array {
	let v = BigInt(n);
	const out: number[] = [];
	do {
		let b = Number(v & 0x7fn);
		v >>= 7n;
		if (v) b |= 0x80;
		out.push(b);
	} while (v);
	return Uint8Array.from(out);
}

export function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
	let shift = 0n;
	let result = 0n;
	let cursor = pos;
	while (true) {
		const b = buf[cursor++];
		result |= BigInt(b & 0x7f) << shift;
		if (!(b & 0x80)) break;
		shift += 7n;
	}
	return [result, cursor];
}

function key(tag: number, wire: number): Uint8Array {
	return encodeVarint((tag << 3) | wire);
}

// ---- field encoders ----
export function fieldString(tag: number, val: string): Uint8Array {
	const bytes = new TextEncoder().encode(val);
	return concat(key(tag, 2), encodeVarint(bytes.length), bytes);
}

export function fieldBool(tag: number, val: boolean): Uint8Array {
	return concat(key(tag, 0), encodeVarint(val ? 1 : 0));
}

export function fieldVarint(tag: number, val: number): Uint8Array {
	return concat(key(tag, 0), encodeVarint(val));
}

export function fieldBytes(tag: number, val: Uint8Array): Uint8Array {
	return concat(key(tag, 2), encodeVarint(val.length), val);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

// ---- generic decoder: returns list of {tag, wire, value} ----
export function decodeMessage(buf: Uint8Array): WireField[] {
	const fields: WireField[] = [];
	let pos = 0;
	while (pos < buf.length) {
		const [k, p1] = readVarint(buf, pos);
		pos = p1;
		const tag = Number(k >> 3n);
		const wire = Number(k & 7n);
		if (wire === 0) {
			const [v, p2] = readVarint(buf, pos);
			pos = p2;
			fields.push({ tag, wire, value: v });
		} else if (wire === 2) {
			const [len, p2] = readVarint(buf, pos);
			const l = Number(len);
			const slice = buf.subarray(p2, p2 + l);
			pos = p2 + l;
			fields.push({ tag, wire, value: slice });
		} else if (wire === 5) {
			fields.push({ tag, wire, value: buf.subarray(pos, pos + 4) });
			pos += 4;
		} else if (wire === 1) {
			fields.push({ tag, wire, value: buf.subarray(pos, pos + 8) });
			pos += 8;
		} else {
			break; // unsupported wire type; stop
		}
	}
	return fields;
}

export function asString(v: bigint | Uint8Array): string {
	if (v instanceof Uint8Array) return new TextDecoder().decode(v);
	return String(v);
}

// ---- gRPC frame helpers ----
// Frame = [1 byte compression flag][4 byte big-endian length][payload]
export function grpcFrame(payload: Uint8Array): Uint8Array {
	const header = new Uint8Array(5);
	header[0] = 0;
	new DataView(header.buffer).setUint32(1, payload.length, false);
	return concat(header, payload);
}

// Split a concatenated gRPC response body into individual message payloads.
export function grpcUnframe(buf: Uint8Array): Uint8Array[] {
	const out: Uint8Array[] = [];
	let pos = 0;
	while (pos + 5 <= buf.length) {
		const len = new DataView(buf.buffer, buf.byteOffset + pos + 1, 4).getUint32(
			0,
			false,
		);
		const start = pos + 5;
		const end = start + len;
		if (end > buf.length) break;
		out.push(buf.subarray(start, end));
		pos = end;
	}
	return out;
}

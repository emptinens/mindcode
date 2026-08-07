import type * as React from 'react'
import { Box, Text } from 'src/ink.js'
import { MessageResponse } from '../MessageResponse.js'

type RateLimitMessageProps = {
  text: string
}

export function RateLimitMessage({
  text,
}: RateLimitMessageProps): React.ReactNode {
  return (
    <MessageResponse>
      <Box>
        <Text color="error">{text}</Text>
      </Box>
    </MessageResponse>
  )
}

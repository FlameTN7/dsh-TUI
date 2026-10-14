import React from 'react'
import { Box, Text, ScrollBox, useInput, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { t } from '../i18n.js'

/** A bounded reader for local command rows; no backend history or model input. */
export function CommandOutputPanel({ title, lines, onClose, onCopy }: {
  readonly title: string
  readonly lines: readonly string[]
  onClose(): void
  onCopy(): void
}): React.ReactNode {
  const scroll = React.useRef<ScrollBoxHandle | null>(null)
  const { rows } = useTerminalSize()
  const height = Math.max(1, rows - 8)
  useInput((input, key, event) => {
    event.stopImmediatePropagation()
    if (key.escape || (key.ctrl && input === 'c')) onClose()
    else if (key.upArrow || key.downArrow) scroll.current?.scrollBy(key.upArrow ? -1 : 1)
    else if (key.pageUp || key.pageDown) scroll.current?.scrollBy(key.pageUp ? -height : height)
    else if (key.home) scroll.current?.scrollTo(0)
    else if (key.end) scroll.current?.scrollToBottom()
    else if (input === 'c' && !key.ctrl && !key.meta) onCopy()
  })
  return (
    <Box height={rows} flexDirection="column" flexShrink={0}>
      <Pane>
        <Text bold wrap="truncate-end">{title}</Text>
        <ScrollBox ref={scroll} flexDirection="column" height={height}>
          {lines.map((line, index) => <Text key={index}>{line}</Text>)}
        </ScrollBox>
        <Text dimColor wrap="truncate-end">{t('command-output-hint')}</Text>
      </Pane>
    </Box>
  )
}

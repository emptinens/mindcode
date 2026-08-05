import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useAnimationFrame } from '../ink.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
import { useAppState } from '../state/AppState.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getRainbowColor } from '../utils/thinking.js'
import { isWorkflowsEnabled } from '../tools/WorkflowTool/gate.js'
import {
  type EffortLevel,
  type EffortValue,
  getDisplayedEffortLevel,
  getSupportedEffortLevels,
  modelSupportsXhighEffort,
} from '../utils/effort.js'

type SliderValue = EffortLevel | 'ultracode'

// Per-level rendering style. Standard tiers use semantic theme keys; xhigh and
// max get animated treatments, and ultracode rides the violet ripple.
type LevelColor =
  | 'subtle'
  | 'warning'
  | 'success'
  | 'permission'
  | 'autoAccept-shimmer'
  | 'rainbow-animated'
  | 'violet-ripple'

type SliderLevel = {
  value: SliderValue
  label: string
  color: LevelColor
}

type Ripple = { travel: number; originCol: number }

type Geometry = {
  levels: SliderLevel[]
  width: number
  trianglePositions: number[]
  labelStarts: number[]
  spacers: number[]
  trackChars: string
  accentStart?: number
  sublabel?: { text: string; start: number }
}

type Props = {
  model: string
  currentEffort: EffortValue | undefined
  ultracode?: boolean
  onSelect: (level: SliderValue) => void
  onCancel: () => void
}

// ---- Geometry constants -------------------------------------------------
const BASE_WIDTH = 42
const ULTRACODE_LEVEL: SliderLevel = {
  value: 'ultracode',
  label: 'ultracode',
  color: 'violet-ripple',
}
const DEFAULT_INDEX = 0

// Left gutter the REPL pads command output by; the ripple band uses a negative
// margin of this size to bleed out to the true terminal edge.
const GUTTER = 2

const HINT_TEXT = '←/→ to adjust · Enter to confirm · Esc to cancel'

// ---- Animation / color constants ---------------------------------------
const SHIMMER_HIGHLIGHT = '#d0b4ff'
const COVERED_TEXT = 'rgb(255,255,255)'
const RIPPLE_SPEED_MS = 80
const RIPPLE_TRAVEL_PER_MS = 0.03
const RIPPLE_WAVELENGTH = 20
const RAINBOW_SPEED_MS = 100
const SHIMMER_SPEED_MS = 100

// Row indices, relative to the labels row (the ripple's vertical origin).
const ROW_TITLE = -2
const ROW_BLANK_TOP = -1
const ROW_FASTER_SMARTER = 0
const ROW_TRACK = 1
const ROW_LABELS = 2
const ROW_SUBLABEL = 3
const ROW_BLANK_BOTTOM = 4
const ROW_HINT = 5

const MAX_WARNING =
  'May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.'

// 8-stop violet ramp (dark → bright) the ripple paints with. The brightest
// stop doubles as the solid violet accent for the track and ultracode label.
const RAMP_LO = [62, 22, 118]
const RAMP_HI = [140, 80, 240]
const RIPPLE_RAMP: string[] = Array.from({ length: 8 }, (_, q) => {
  const k = q / 7
  const c = (i: number) =>
    Math.round(RAMP_LO[i]! + (RAMP_HI[i]! - RAMP_LO[i]!) * k)
  return `rgb(${c(0)},${c(1)},${c(2)})`
})
const VIOLET = RIPPLE_RAMP[RIPPLE_RAMP.length - 1]!

const pad = (n: number): string => ' '.repeat(Math.max(0, n))

// ---- Geometry -----------------------------------------------------------
function computeLabelStarts(
  levels: SliderLevel[],
  spacers: number[],
): number[] {
  return levels.map((_, i) =>
    levels
      .slice(0, i)
      .reduce((acc, lvl, j) => acc + lvl.label.length + spacers[j]!, 0),
  )
}

function ultracodeAvailable(model: string): boolean {
  return isWorkflowsEnabled() && modelSupportsXhighEffort(model)
}

function effortLevelColor(level: EffortLevel): LevelColor {
  switch (level) {
    case 'max':
      return 'rainbow-animated'
    case 'xhigh':
      return 'autoAccept-shimmer'
    case 'high':
      return 'permission'
    case 'medium':
      return 'success'
    case 'low':
      return 'warning'
    case 'none':
    case 'minimal':
    case 'auto':
      return 'subtle'
  }
}

function getSliderGeometry(model: string): Geometry {
  const advertised = getSupportedEffortLevels(model)
  const baseLevels: SliderLevel[] = (advertised.length > 0 ? advertised : ['auto']).map(
    value => ({ value, label: value, color: effortLevelColor(value) }),
  )
  const spacers = Array.from(
    { length: Math.max(0, baseLevels.length - 1) },
    () => 5,
  )
  const labelsWidth = baseLevels.reduce(
    (total, level) => total + level.label.length,
    0,
  )
  const width = Math.max(BASE_WIDTH, labelsWidth + spacers.reduce((a, b) => a + b, 0))
  const trianglePositions = baseLevels.map((_, index) =>
    baseLevels.length === 1
      ? Math.floor(width / 2)
      : Math.round((index * (width - 1)) / (baseLevels.length - 1)),
  )
  const base: Geometry = {
    levels: baseLevels,
    width,
    trianglePositions,
    labelStarts: computeLabelStarts(baseLevels, spacers),
    spacers,
    trackChars: '─'.repeat(width),
  }
  if (!ultracodeAvailable(model)) return base

  const ultraStart = width + 3
  const levels = [...baseLevels, ULTRACODE_LEVEL]
  const ultraSpacers = [...spacers, ultraStart + 4 - width]
  return {
    levels,
    width: ultraStart + 17,
    trianglePositions: [...trianglePositions, ultraStart + 8],
    labelStarts: computeLabelStarts(levels, ultraSpacers),
    spacers: ultraSpacers,
    trackChars: `${'─'.repeat(width + 1)}┆${'─'.repeat(18)}`,
    accentStart: width + 2,
    sublabel: { text: 'xhigh + workflows', start: ultraStart },
  }
}

// ---- Ripple math --------------------------------------------------------
function rippleDistance(col: number, row: number, originCol: number): number {
  const dx = col - originCol
  const dy = (row - ROW_LABELS) * 2
  return Math.sqrt(dx * dx + dy * dy)
}

// Returns a ramp index for cells the wavefront has already reached, or null
// for cells still beyond the expanding radius (rendered dim/uncovered).
function rippleLevel(distance: number, ripple: Ripple): number | null {
  if (distance > ripple.travel) return null
  const phase =
    (((distance - ripple.travel) % RIPPLE_WAVELENGTH) + RIPPLE_WAVELENGTH) %
    RIPPLE_WAVELENGTH
  const t = (1 + Math.cos((2 * Math.PI * phase) / RIPPLE_WAVELENGTH)) / 2
  return Math.min(
    RIPPLE_RAMP.length - 1,
    Math.round(t * (RIPPLE_RAMP.length - 1)),
  )
}

// ---- Animated text pieces ----------------------------------------------
function UltraRippleText({
  text,
  col,
  row,
  ripple,
  dimColor,
  bold,
  coveredColor,
}: {
  text: string
  col: number
  row: number
  ripple: Ripple
  dimColor?: boolean
  bold?: boolean
  coveredColor?: string
}): React.ReactNode {
  // Group consecutive characters that share a ramp level into one <Text> run.
  const segments: { text: string; level: number | null }[] = []
  let offset = 0
  for (const ch of [...text]) {
    const level = rippleLevel(
      rippleDistance(col + offset, row, ripple.originCol),
      ripple,
    )
    const last = segments[segments.length - 1]
    if (last && last.level === level) last.text += ch
    else segments.push({ text: ch, level })
    offset++
  }
  return (
    <Text>
      {segments.map((seg, i) =>
        seg.level === null ? (
          <Text key={i} dimColor={dimColor} bold={bold}>
            {seg.text}
          </Text>
        ) : (
          <Text
            key={i}
            backgroundColor={RIPPLE_RAMP[seg.level]}
            color={coveredColor ?? COVERED_TEXT}
            bold={bold}
          >
            {seg.text}
          </Text>
        ),
      )}
    </Text>
  )
}

function RainbowText({
  text,
  reducedMotion,
}: {
  text: string
  reducedMotion: boolean
}): React.ReactNode {
  const [, time] = useAnimationFrame(reducedMotion ? null : RAINBOW_SPEED_MS)
  const frame = reducedMotion ? 0 : Math.floor(time / RAINBOW_SPEED_MS)
  return (
    <Text bold>
      {[...text].map((ch, i) => (
        <Text key={i} color={getRainbowColor(i + frame)}>
          {ch}
        </Text>
      ))}
    </Text>
  )
}

function ShimmerLabel({
  text,
  reducedMotion,
}: {
  text: string
  reducedMotion: boolean
}): React.ReactNode {
  const [, time] = useAnimationFrame(reducedMotion ? null : SHIMMER_SPEED_MS)
  const cycle = text.length + 4
  const pos = reducedMotion ? -100 : Math.floor(time / SHIMMER_SPEED_MS) % cycle
  return (
    <Text bold>
      {[...text].map((ch, i) => {
        const isHot = i === pos
        const isNear = i === pos - 1 || i === pos + 1
        return (
          <Text
            key={i}
            color={isHot ? SHIMMER_HIGHLIGHT : 'autoAccept'}
            bold={isHot || isNear}
          >
            {ch}
          </Text>
        )
      })}
    </Text>
  )
}

function LevelLabel({
  level,
  selected,
  reducedMotion,
}: {
  level: SliderLevel
  selected: boolean
  reducedMotion: boolean
}): React.ReactNode {
  const label = level.label
  if (!selected) {
    if (level.color === 'violet-ripple')
      return <Text color={VIOLET}>{label}</Text>
    return <Text dimColor>{label}</Text>
  }
  if (level.color === 'violet-ripple')
    return (
      <Text bold backgroundColor={VIOLET} color={COVERED_TEXT}>
        {label}
      </Text>
    )
  if (level.color === 'rainbow-animated')
    return <RainbowText text={label} reducedMotion={reducedMotion} />
  if (level.color === 'autoAccept-shimmer')
    return <ShimmerLabel text={label} reducedMotion={reducedMotion} />
  return (
    <Text bold color={level.color}>
      {label}
    </Text>
  )
}

// ---- Slider -------------------------------------------------------------
export function EffortSlider({
  model,
  currentEffort,
  ultracode,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const reducedMotion =
    useAppState(s => s.settings.prefersReducedMotion) ?? false
  const { columns } = useTerminalSize()
  const geo = useMemo(() => getSliderGeometry(model), [model])
  const startIndex = useMemo(() => {
    if (ultracode) {
      const idx = geo.levels.findIndex(l => l.value === 'ultracode')
      if (idx !== -1) return idx
    }
    const displayed = getDisplayedEffortLevel(model, currentEffort)
    const idx = geo.levels.findIndex(l => l.value === displayed)
    return idx === -1 ? DEFAULT_INDEX : idx
  }, [geo, model, currentEffort, ultracode])

  const [index, setIndex] = useState(startIndex)
  const w = Math.min(index, geo.levels.length - 1)
  const selected = geo.levels[w]!
  const isUltraSelected = selected.value === 'ultracode'

  // Expanding ripple, anchored to the selected triangle. The baseline ref
  // resets whenever ultracode isn't the live selection so travel restarts
  // from zero each time the user lands on it.
  const rippleActive = isUltraSelected && !reducedMotion
  const [, time] = useAnimationFrame(rippleActive ? RIPPLE_SPEED_MS : null)
  const baseRef = useRef<number | null>(null)
  if (!rippleActive) baseRef.current = null
  else if (baseRef.current === null) baseRef.current = time
  const elapsed = rippleActive ? time - (baseRef.current ?? time) : 0

  useInput((_input, key) => {
    if (key.escape) onCancel()
    else if (key.leftArrow) setIndex(prev => Math.max(0, prev - 1))
    else if (key.rightArrow)
      setIndex(prev => Math.min(geo.levels.length - 1, prev + 1))
    else if (key.return) onSelect(selected.value)
  })

  const width = geo.width
  const triCol = geo.trianglePositions[w]!
  const fasterFill = pad(width - 'Faster'.length - 'Smarter'.length)

  // Track split around the triangle (+ optional violet accent zone covering
  // the ultracode region when it's available).
  const trackLeft = geo.trackChars.slice(0, triCol)
  const trackRight = geo.trackChars.slice(triCol + 1)
  const accent = geo.accentStart ?? geo.trackChars.length
  const leftDim = trackLeft.slice(0, Math.min(trackLeft.length, accent))
  const leftAccent = trackLeft.slice(Math.min(trackLeft.length, accent))
  const triInAccent = triCol >= accent
  const rightAccentStart = Math.max(0, accent - triCol - 1)
  const rightDim = trackRight.slice(0, rightAccentStart)
  const rightAccent = trackRight.slice(rightAccentStart)

  const lastStart = geo.labelStarts[geo.labelStarts.length - 1]!
  const lastLabelLen = geo.levels[geo.levels.length - 1]!.label.length
  const labelsEnd = lastStart + lastLabelLen
  const trailing = pad(width - labelsEnd)

  // Full-bleed band geometry: a terminal-wide strip centered on the slider
  // that the violet wave radiates across (title and hint rows included).
  const i = Math.max(width, columns)
  const r = Math.max(0, Math.floor((i - width) / 2))
  const e = pad(r)
  const qH = pad(i - r - width)
  const tPad = pad(GUTTER)
  const fullRow = pad(i)

  if (rippleActive) {
    const ripple: Ripple = {
      travel: elapsed * RIPPLE_TRAVEL_PER_MS,
      originCol: triCol,
    }
    return (
      <Pane color="permission">
        <Box flexDirection="column" marginX={-GUTTER} width={i}>
        {/* title */}
        <UltraRippleText
          text={`${tPad}Effort${pad(i - GUTTER - 'Effort'.length)}`}
          col={-r}
          row={ROW_TITLE}
          ripple={ripple}
        />
        {/* blank */}
        <UltraRippleText
          text={fullRow}
          col={-r}
          row={ROW_BLANK_TOP}
          ripple={ripple}
        />
        {/* Faster … Smarter */}
        <UltraRippleText
          text={`${e}Faster${fasterFill}Smarter${qH}`}
          col={-r}
          row={ROW_FASTER_SMARTER}
          ripple={ripple}
        />
        {/* track */}
        <Box>
          <UltraRippleText
            text={`${e}${trackLeft}`}
            col={-r}
            row={ROW_TRACK}
            ripple={ripple}
            dimColor
            coveredColor={SHIMMER_HIGHLIGHT}
          />
          <Text bold backgroundColor={VIOLET} color={COVERED_TEXT}>
            ▲
          </Text>
          <UltraRippleText
            text={`${trackRight}${qH}`}
            col={triCol + 1}
            row={ROW_TRACK}
            ripple={ripple}
            dimColor
            coveredColor={SHIMMER_HIGHLIGHT}
          />
        </Box>
        {/* labels */}
        <Box>
          <UltraRippleText text={e} col={-r} row={ROW_LABELS} ripple={ripple} />
          {geo.levels.map((lvl, idx) => (
            <React.Fragment key={lvl.value}>
              {idx > 0 && (
                <UltraRippleText
                  text={pad(geo.spacers[idx - 1]!)}
                  col={geo.labelStarts[idx]! - geo.spacers[idx - 1]!}
                  row={ROW_LABELS}
                  ripple={ripple}
                />
              )}
              {w !== idx ? (
                <UltraRippleText
                  text={lvl.label}
                  col={geo.labelStarts[idx]!}
                  row={ROW_LABELS}
                  ripple={ripple}
                  dimColor
                />
              ) : (
                <LevelLabel
                  level={lvl}
                  selected
                  reducedMotion={reducedMotion}
                />
              )}
            </React.Fragment>
          ))}
          <UltraRippleText
            text={`${trailing}${qH}`}
            col={labelsEnd}
            row={ROW_LABELS}
            ripple={ripple}
          />
        </Box>
        {/* ultracode sublabel */}
        {geo.sublabel ? (
          <UltraRippleText
            text={`${e}${pad(geo.sublabel.start)}${geo.sublabel.text}${qH}`}
            col={-r}
            row={ROW_SUBLABEL}
            ripple={ripple}
            dimColor
          />
        ) : null}
        {/* blank */}
        <UltraRippleText
          text={fullRow}
          col={-r}
          row={ROW_BLANK_BOTTOM}
          ripple={ripple}
        />
        {/* hint */}
        <UltraRippleText
          text={`${tPad}${HINT_TEXT}${pad(i - GUTTER - HINT_TEXT.length)}`}
          col={-r}
          row={ROW_HINT}
          ripple={ripple}
          dimColor
        />
        </Box>
      </Pane>
    )
  }

  // Non-ripple: plain, gutter-aligned layout (no full-width violet band).
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Text bold>Effort</Text>
      <Box height={1} />
      <Box flexDirection="column" alignItems="center" width="100%">
        <Box width={width}>
          <Text>Faster</Text>
          <Text>{fasterFill}</Text>
          <Text>Smarter</Text>
        </Box>
        <Box width={width}>
          <Text dimColor>{leftDim}</Text>
          {leftAccent ? <Text color={VIOLET}>{leftAccent}</Text> : null}
          <Text bold color={triInAccent ? VIOLET : undefined}>
            ▲
          </Text>
          <Text dimColor>{rightDim}</Text>
          {rightAccent ? <Text color={VIOLET}>{rightAccent}</Text> : null}
        </Box>
        <Box width={width}>
          {geo.levels.map((lvl, idx) => (
            <React.Fragment key={lvl.value}>
              {idx > 0 && <Text>{pad(geo.spacers[idx - 1]!)}</Text>}
              <LevelLabel
                level={lvl}
                selected={w === idx}
                reducedMotion={reducedMotion}
              />
            </React.Fragment>
          ))}
          {trailing ? <Text>{trailing}</Text> : null}
        </Box>
        {geo.sublabel ? (
          <Box width={width}>
            <Text>{pad(geo.sublabel.start)}</Text>
            <Text dimColor>{geo.sublabel.text}</Text>
          </Box>
        ) : null}
        {selected.value === 'max' ? (
          <Box marginTop={1} width={width}>
            <Text dimColor>{MAX_WARNING}</Text>
          </Box>
        ) : null}
      </Box>
      <Box height={1} />
      <Text dimColor italic>
        <Byline>
          <KeyboardShortcutHint shortcut="←/→" action="adjust" />
          <KeyboardShortcutHint shortcut="Enter" action="confirm" />
          <KeyboardShortcutHint shortcut="Esc" action="cancel" />
        </Byline>
      </Text>
      </Box>
    </Pane>
  )
}

export interface Viewport {
  x: number
  y: number
  scale: number
}

export interface RectN {
  x: number
  y: number
  w: number
  h: number
}

export interface PdfMarkPage {
  page: number // 1-based
  rects: RectN[] // 相对页面的归一化矩形
}

export interface Mark {
  id: string
  kind: 'pdf' | 'card'
  /** pdf 标注：各页的归一化矩形；card 标注：无 */
  pages?: PdfMarkPage[]
  /** card 标注：标注所在的卡片 */
  ownerCardId?: string
  text: string
  depth: number
  targetCardId: string | null
  createdAt: number
  applied?: boolean // card 标注是否已写入 DOM
  dangling?: boolean // 重新载入后未能重新定位
  v2?: boolean // pdf 标注：是否已按字形墨迹带收紧（旧数据加载时迁移）
}

export interface FollowUp {
  q: string
  a: string
  pending?: boolean
}

export interface CardMemo {
  summary: string
  concepts: string[]
  related: number[]
}

export interface Card {
  id: string
  x: number
  y: number
  width: number
  height?: number
  question?: string
  fontScale: number
  depth: number
  sourceMarkId: string | null
  sourceText: string
  content: string
  title: string
  status: 'loading' | 'streaming' | 'done' | 'error'
  error?: string
  memo: CardMemo | null
  followups: FollowUp[]
  parentId: string | null
  createdAt: number
}

export interface DocMeta {
  id: string
  title: string
  pages: { index: number; text: string }[]
}

export interface SavedState {
  viewport: Viewport
  pdfNode: { x: number; y: number; width: number; height?: number; scrollTop?: number; resized?: boolean }
  cards: Card[]
  marks: Mark[]
  cardSeq: number
}

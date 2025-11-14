export type MathNodeType =
  | 'text'
  | 'fraction'
  | 'highlighted'
  | 'arrow'
  | 'italic'
  | 'image'
  | 'subscript'
  | 'superscript'
  | 'handwritten';

export interface MathNode {
  type: MathNodeType;
  content: string;
  color?: string;
  url?: string;
  numerator?: string;
  denominator?: string;
  isHandwritten?: boolean;
}

export interface ContentBlock {
  type: 'block' | 'inlineGroup';
  label?: string;
  content: string;
  structuredContent?: MathNode[];
  children?: ContentBlock[];
}


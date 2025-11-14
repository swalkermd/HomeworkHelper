import { MathNode } from '../types/math';

function findMatchingBracket(content: string, startIndex: number, openChar: string, closeChar: string): number {
  let depth = 1;
  let i = startIndex + 1;

  while (i < content.length && depth > 0) {
    if (content[i] === openChar) {
      depth++;
    } else if (content[i] === closeChar) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }

  return -1;
}

function parseHighlightedContent(content: string, color: string, isHandwritten: boolean): MathNode[] {
  const parts: MathNode[] = [];
  let i = 0;
  let currentText = '';

  while (i < content.length) {
    if (content[i] === '{' && content.indexOf('}', i) > i) {
      if (currentText) {
        parts.push({ type: 'highlighted', content: currentText, color, isHandwritten });
        currentText = '';
      }
      const endIndex = content.indexOf('}', i);
      const fractionContent = content.substring(i + 1, endIndex);
      const [num, den] = fractionContent.split('/');
      if (num && den) {
        parts.push({
          type: 'fraction',
          content: fractionContent,
          numerator: num.trim(),
          denominator: den.trim(),
          color,
          isHandwritten,
        });
      } else {
        currentText += fractionContent;
      }
      i = endIndex + 1;
    } else {
      currentText += content[i];
      i++;
    }
  }

  if (currentText) {
    parts.push({ type: 'highlighted', content: currentText, color, isHandwritten });
  }

  return parts;
}

function parseContentInternal(content: string, isHandwritten: boolean = false): MathNode[] {
  const parts: MathNode[] = [];
  let i = 0;
  let currentText = '';

  const flushCurrentText = () => {
    if (currentText) {
      parts.push({ type: 'text', content: currentText, isHandwritten });
      currentText = '';
    }
  };

  while (i < content.length) {
    if (content[i] === '{' && content.indexOf('}', i) > i) {
      flushCurrentText();
      const endIndex = content.indexOf('}', i);
      const fractionContent = content.substring(i + 1, endIndex);
      const [num, den] = fractionContent.split('/');
      if (num && den) {
        parts.push({
          type: 'fraction',
          content: fractionContent,
          numerator: num.trim(),
          denominator: den.trim(),
          isHandwritten,
        });
      } else {
        parts.push({ type: 'text', content: fractionContent, isHandwritten });
      }
      i = endIndex + 1;
    } else if (content[i] === '[' && content.indexOf(':', i) > i) {
      const endIndex = findMatchingBracket(content, i, '[', ']');
      if (endIndex > i) {
        flushCurrentText();
        const highlightContent = content.substring(i + 1, endIndex);
        const colonIndex = highlightContent.indexOf(':');
        if (colonIndex > -1) {
          const tagName = highlightContent.substring(0, colonIndex);
          const taggedText = highlightContent.substring(colonIndex + 1).trim();

          if (tagName.trim().toLowerCase() === 'handwritten') {
            const handwrittenParts = parseContentInternal(taggedText, true);
            parts.push(...handwrittenParts);
          } else {
            const highlightedParts = parseHighlightedContent(taggedText, tagName.trim(), isHandwritten);
            parts.push(...highlightedParts);
          }
        } else {
          currentText += content[i];
          i++;
          continue;
        }
        i = endIndex + 1;
      } else {
        currentText += content[i];
        i++;
      }
    } else if ((content.substring(i, i + 2) === '->' || content.substring(i, i + 2) === '=>')) {
      flushCurrentText();
      parts.push({ type: 'arrow', content: content.substring(i, i + 2), isHandwritten });
      i += 2;
    } else if (content[i] === '(' && content.substring(i, i + 7) === '(IMAGE:') {
      const closingParenIndex = content.indexOf(')', i + 7);
      if (closingParenIndex > i) {
        flushCurrentText();
        const imageContent = content.substring(i + 7, closingParenIndex);
        const separatorIndex = imageContent.indexOf('](');
        if (separatorIndex > -1) {
          const desc = imageContent.substring(0, separatorIndex).trim();
          const url = imageContent.substring(separatorIndex + 2).trim();
          parts.push({ type: 'image', content: desc, url, isHandwritten });
          i = closingParenIndex + 1;
        } else {
          currentText += content[i];
          i++;
        }
      } else {
        currentText += content[i];
        i++;
      }
    } else if (content[i] === '_' && content.indexOf('_', i + 1) > i) {
      flushCurrentText();
      const endIndex = content.indexOf('_', i + 1);
      const subscriptContent = content.substring(i + 1, endIndex);
      parts.push({ type: 'subscript', content: subscriptContent, isHandwritten });
      i = endIndex + 1;
    } else if (content[i] === '^' && content.indexOf('^', i + 1) > i) {
      flushCurrentText();
      const endIndex = content.indexOf('^', i + 1);
      const superscriptContent = content.substring(i + 1, endIndex);
      parts.push({ type: 'superscript', content: superscriptContent, isHandwritten });
      i = endIndex + 1;
    } else if (content[i] === '+' && content[i + 1] === '+' && content.indexOf('++', i + 2) > i) {
      flushCurrentText();
      const endIndex = content.indexOf('++', i + 2);
      const italicContent = content.substring(i + 2, endIndex);
      parts.push({ type: 'italic', content: italicContent, isHandwritten });
      i = endIndex + 2;
    } else {
      currentText += content[i];
      i++;
    }
  }

  flushCurrentText();

  return parts;
}

export function parseMathContent(content: string): MathNode[] {
  if (!content) {
    return [];
  }
  return parseContentInternal(content, false);
}


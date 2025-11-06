export function normalizeContent(content: string): string {
  let normalized = content;

  normalized = normalized.replace(/(\d+)\/(\d+)(?![}])/g, '{$1/$2}');
  
  normalized = normalized.replace(/\b(m\/s|km\/h|cm\/s)\b/gi, (match) => match);
  
  normalized = normalized.replace(/\n\s*([:])/g, '$1');
  normalized = normalized.replace(/\n\s*([.,!?])/g, '$1');
  
  normalized = normalized.replace(/backinto/g, 'back into');
  
  normalized = normalized.replace(/\n\s*(->|=>)\s*\n/g, ' $1 ');
  
  return normalized;
}

export function detectSubject(problemText: string): string {
  const text = problemText.toLowerCase();
  
  if (
    text.includes('molecule') ||
    text.includes('atom') ||
    text.includes('compound') ||
    text.includes('reaction') ||
    text.includes('balance') ||
    /h_?\d+_?o/i.test(text) ||
    /co_?\d+/i.test(text)
  ) {
    return 'Chemistry';
  }
  
  if (
    text.includes('velocity') ||
    text.includes('force') ||
    text.includes('acceleration') ||
    text.includes('distance') ||
    text.includes('energy') ||
    text.includes('motion') ||
    text.includes('physics')
  ) {
    return 'Physics';
  }
  
  if (
    text.includes('verse') ||
    text.includes('scripture') ||
    text.includes('testament') ||
    text.includes('gospel') ||
    /\d+:\d+/.test(text)
  ) {
    return 'Bible Studies';
  }
  
  if (
    text.includes('metaphor') ||
    text.includes('theme') ||
    text.includes('character') ||
    text.includes('analyze') ||
    text.includes('essay') ||
    text.includes('author')
  ) {
    return 'Language Arts';
  }
  
  if (
    text.includes('country') ||
    text.includes('capital') ||
    text.includes('continent') ||
    text.includes('border') ||
    text.includes('ocean') ||
    text.includes('river')
  ) {
    return 'Geography';
  }
  
  if (
    text.includes('solve') ||
    text.includes('equation') ||
    text.includes('calculate') ||
    text.includes('simplify') ||
    text.includes('variable') ||
    /\d+[x]\s*[+\-*/]/.test(text)
  ) {
    return 'Math';
  }
  
  return 'General';
}

export function detectDifficulty(problemText: string): string {
  const text = problemText.toLowerCase();
  
  if (
    text.includes('calculus') ||
    text.includes('derivative') ||
    text.includes('integral') ||
    text.includes('theorem') ||
    /[α-ωΑ-Ω]/.test(text)
  ) {
    return 'College+';
  }
  
  if (
    text.includes('quadratic') ||
    text.includes('trigonometry') ||
    text.includes('logarithm') ||
    text.includes('polynomial')
  ) {
    return '9-12';
  }
  
  if (
    text.includes('variable') ||
    text.includes('equation') ||
    text.includes('percentage') ||
    text.includes('ratio')
  ) {
    return '6-8';
  }
  
  return 'K-5';
}

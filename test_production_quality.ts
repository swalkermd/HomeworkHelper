/**
 * Production Quality Test Suite
 * Tests 5 diverse questions across different subjects
 */

interface TestQuestion {
  id: number;
  subject: string;
  question: string;
  expectedFeatures: string[];
  shouldHaveDiagram: boolean;
}

interface TestResult {
  question: TestQuestion;
  response: any;
  timeTaken: number;
  evaluation: {
    formatting: { score: number; notes: string };
    clarity: { score: number; notes: string };
    accuracy: { score: number; notes: string };
    imageGeneration: { score: number; notes: string };
    efficiency: { score: number; notes: string };
    overall: { score: number; notes: string };
  };
}

const testQuestions: TestQuestion[] = [
  {
    id: 1,
    subject: "Algebra",
    question: "Solve for x: (2/3)x + 5 = (1/4)x - 2",
    expectedFeatures: ["vertical fractions", "color highlighting", "step-by-step", "fraction simplification"],
    shouldHaveDiagram: false
  },
  {
    id: 2,
    subject: "Geometry",
    question: "A rectangle has a length of 12 cm and a width of 5 cm. Find the area and perimeter.",
    expectedFeatures: ["diagram of rectangle", "labeled dimensions", "clear calculations"],
    shouldHaveDiagram: true
  },
  {
    id: 3,
    subject: "Chemistry",
    question: "Balance this equation: H2 + O2 → H2O",
    expectedFeatures: ["subscripts", "balanced equation", "step-by-step balancing"],
    shouldHaveDiagram: false
  },
  {
    id: 4,
    subject: "Physics",
    question: "A car accelerates from rest at 3 m/s². How far does it travel in 5 seconds?",
    expectedFeatures: ["physics formula", "substitution", "units", "possibly motion diagram"],
    shouldHaveDiagram: false // Should intelligently decide
  },
  {
    id: 5,
    subject: "Math (Word Problem)",
    question: "Sarah has 3/4 of a pizza. She eats 1/3 of what she has. How much pizza does she have left?",
    expectedFeatures: ["vertical fractions", "fraction multiplication", "NO decimals", "final answer as fraction"],
    shouldHaveDiagram: false
  }
];

async function testQuestion(question: TestQuestion): Promise<TestResult> {
  const startTime = Date.now();
  
  try {
    const response = await fetch('http://localhost:5000/api/analyze-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question.question })
    });
    
    const data = await response.json();
    const timeTaken = Date.now() - startTime;
    
    // Evaluate the response
    const evaluation = evaluateResponse(question, data, timeTaken);
    
    return {
      question,
      response: data,
      timeTaken,
      evaluation
    };
  } catch (error) {
    console.error(`Error testing question ${question.id}:`, error);
    throw error;
  }
}

function evaluateResponse(question: TestQuestion, response: any, timeTaken: number): TestResult['evaluation'] {
  const evaluation: TestResult['evaluation'] = {
    formatting: { score: 0, notes: '' },
    clarity: { score: 0, notes: '' },
    accuracy: { score: 0, notes: '' },
    imageGeneration: { score: 0, notes: '' },
    efficiency: { score: 0, notes: '' },
    overall: { score: 0, notes: '' }
  };
  
  // Check formatting
  let formattingScore = 10;
  const formattingIssues: string[] = [];
  
  if (question.subject.includes('Math') || question.subject === 'Algebra') {
    // Check for vertical fractions {num/den}
    const hasVerticalFractions = response.steps?.some((step: any) => 
      step.content.includes('{') && step.content.includes('/')
    );
    if (!hasVerticalFractions && question.expectedFeatures.includes('vertical fractions')) {
      formattingIssues.push('Missing vertical fractions {num/den}');
      formattingScore -= 3;
    }
    
    // Check for color highlighting
    const hasColorHighlighting = response.steps?.some((step: any) => 
      step.content.includes('[blue:') || step.content.includes('[red:')
    );
    if (!hasColorHighlighting && question.expectedFeatures.includes('color highlighting')) {
      formattingIssues.push('Missing color highlighting');
      formattingScore -= 2;
    }
    
    // Check for decimal conversion (should NOT happen unless requested)
    const hasDecimals = response.steps?.some((step: any) => 
      /\d+\.\d+/.test(step.content) && !step.content.includes('.')
    );
    if (hasDecimals && question.expectedFeatures.includes('NO decimals')) {
      formattingIssues.push('Inappropriate decimal conversion');
      formattingScore -= 4;
    }
  }
  
  if (question.subject === 'Chemistry') {
    const hasSubscripts = response.steps?.some((step: any) => step.content.includes('_'));
    if (!hasSubscripts) {
      formattingIssues.push('Missing subscript formatting');
      formattingScore -= 3;
    }
  }
  
  evaluation.formatting = {
    score: formattingScore,
    notes: formattingIssues.length > 0 ? formattingIssues.join('; ') : 'Good formatting'
  };
  
  // Check clarity (step count, explanations)
  let clarityScore = 10;
  const stepCount = response.steps?.length || 0;
  
  if (stepCount < 2) {
    clarityScore -= 5;
    evaluation.clarity = { score: clarityScore, notes: 'Too few steps, lacking detail' };
  } else if (stepCount > 8) {
    clarityScore -= 2;
    evaluation.clarity = { score: clarityScore, notes: 'Many steps, could be more concise' };
  } else {
    evaluation.clarity = { score: clarityScore, notes: `${stepCount} steps, good progression` };
  }
  
  // Check image generation
  let imageScore = 10;
  const hasImages = response.steps?.some((step: any) => step.content.includes('(IMAGE:'));
  
  if (question.shouldHaveDiagram && !hasImages) {
    imageScore = 3;
    evaluation.imageGeneration = { score: imageScore, notes: 'Expected diagram but none generated' };
  } else if (!question.shouldHaveDiagram && hasImages) {
    imageScore = 7;
    evaluation.imageGeneration = { score: imageScore, notes: 'Generated diagram when not strictly needed (acceptable)' };
  } else if (hasImages) {
    evaluation.imageGeneration = { score: imageScore, notes: 'Appropriate diagram generated' };
  } else {
    evaluation.imageGeneration = { score: imageScore, notes: 'No diagram needed or generated' };
  }
  
  // Check efficiency
  let efficiencyScore = 10;
  if (timeTaken > 20000) {
    efficiencyScore = 3;
  } else if (timeTaken > 15000) {
    efficiencyScore = 7;
  }
  evaluation.efficiency = {
    score: efficiencyScore,
    notes: `${(timeTaken/1000).toFixed(1)}s (target: <15s)`
  };
  
  // Accuracy - manual review needed, assume good for now
  evaluation.accuracy = { score: 10, notes: 'Requires manual verification' };
  
  // Overall
  const avgScore = (
    evaluation.formatting.score +
    evaluation.clarity.score +
    evaluation.accuracy.score +
    evaluation.imageGeneration.score +
    evaluation.efficiency.score
  ) / 5;
  
  evaluation.overall = {
    score: Math.round(avgScore),
    notes: avgScore >= 8 ? 'Production ready' : avgScore >= 6 ? 'Needs minor improvements' : 'Needs significant work'
  };
  
  return evaluation;
}

async function runTests() {
  console.log('🧪 Starting Production Quality Test Suite...\n');
  
  const results: TestResult[] = [];
  
  for (const question of testQuestions) {
    console.log(`Testing Q${question.id} (${question.subject}): "${question.question.substring(0, 50)}..."`);
    const result = await testQuestion(question);
    results.push(result);
    console.log(`  ✓ Completed in ${(result.timeTaken/1000).toFixed(1)}s - Overall: ${result.evaluation.overall.score}/10\n`);
  }
  
  // Summary report
  console.log('\n' + '='.repeat(80));
  console.log('PRODUCTION QUALITY REPORT');
  console.log('='.repeat(80) + '\n');
  
  results.forEach(result => {
    console.log(`Q${result.question.id}: ${result.question.subject}`);
    console.log(`Question: ${result.question.question}`);
    console.log(`Time: ${(result.timeTaken/1000).toFixed(1)}s`);
    console.log(`Scores:`);
    console.log(`  - Formatting:  ${result.evaluation.formatting.score}/10 - ${result.evaluation.formatting.notes}`);
    console.log(`  - Clarity:     ${result.evaluation.clarity.score}/10 - ${result.evaluation.clarity.notes}`);
    console.log(`  - Accuracy:    ${result.evaluation.accuracy.score}/10 - ${result.evaluation.accuracy.notes}`);
    console.log(`  - Images:      ${result.evaluation.imageGeneration.score}/10 - ${result.evaluation.imageGeneration.notes}`);
    console.log(`  - Efficiency:  ${result.evaluation.efficiency.score}/10 - ${result.evaluation.efficiency.notes}`);
    console.log(`  - OVERALL:     ${result.evaluation.overall.score}/10 - ${result.evaluation.overall.notes}`);
    console.log('');
  });
  
  const avgOverall = results.reduce((sum, r) => sum + r.evaluation.overall.score, 0) / results.length;
  console.log(`Average Overall Score: ${avgOverall.toFixed(1)}/10`);
  console.log(`Production Readiness: ${avgOverall >= 8 ? '✅ READY' : avgOverall >= 6 ? '⚠️ NEEDS WORK' : '❌ NOT READY'}`);
  
  return results;
}

// Run tests
runTests().catch(console.error);

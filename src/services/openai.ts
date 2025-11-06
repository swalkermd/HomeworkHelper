import { HomeworkSolution, SimplifiedExplanation } from '../types';

const API_URL = '/api';

export async function analyzeTextQuestion(question: string): Promise<any> {
  try {
    console.log('📡 Calling API:', `${API_URL}/analyze-text`);
    console.log('📡 Fetch starting...');
    console.log('⏱️ Starting analysis at:', new Date().toISOString());
    
    // Reduced timeout to 30 seconds (diagrams disabled for speed)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log('⏱️ Timeout triggered after 30 seconds');
      controller.abort();
    }, 30000);
    
    const response = await fetch(`${API_URL}/analyze-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    console.log('📡 Response received! Status:', response.status, 'OK:', response.ok);
    
    if (!response.ok) {
      console.error('❌ Response not OK:', response.status);
      const errorData = await response.json().catch(() => ({}));
      console.error('❌ Error data:', errorData);
      throw new Error(errorData.error || 'Failed to analyze question');
    }
    
    console.log('📡 Parsing JSON response...');
    const result = await response.json();
    console.log('✅ JSON parsed successfully!');
    console.log('✓ Text API Response:', {
      hasSteps: !!result?.steps,
      stepsCount: result?.steps?.length,
      subject: result?.subject,
      difficulty: result?.difficulty,
      hasProblem: !!result?.problem
    });
    return result;
  } catch (error) {
    console.error('❌ FETCH ERROR:', error);
    console.error('❌ Error message:', error instanceof Error ? error.message : String(error));
    console.error('❌ Error stack:', error instanceof Error ? error.stack : 'No stack');
    
    // Check if it's a timeout/abort error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timed out. The problem might be too complex. Please try again.');
    }
    
    throw error;
  }
}

export async function analyzeImageQuestion(imageUri: string, problemNumber?: string): Promise<any> {
  try {
    console.log('Calling API:', `${API_URL}/analyze-image`);
    console.log('⏱️ Starting analysis at:', new Date().toISOString());
    
    // Reduced timeout to 30 seconds (diagrams disabled for speed)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log('⏱️ Timeout triggered after 30 seconds');
      controller.abort();
    }, 30000);
    
    console.log('📡 Sending request...');
    const response = await fetch(`${API_URL}/analyze-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ imageUri, problemNumber }),
      signal: controller.signal,
    });
    
    console.log('📥 Response received, status:', response.status);
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('API Error Response:', response.status, errorData);
      throw new Error(errorData.error || 'Failed to analyze image');
    }
    
    console.log('🔍 Parsing response JSON...');
    const result = await response.json();
    console.log('✓ Image API Response parsed successfully:', {
      hasSteps: !!result?.steps,
      stepsCount: result?.steps?.length,
      subject: result?.subject,
      difficulty: result?.difficulty,
      hasProblem: !!result?.problem
    });
    console.log('⏱️ Analysis completed at:', new Date().toISOString());
    return result;
  } catch (error) {
    console.error('❌ Error analyzing image question:', error);
    console.error('❌ Error type:', error instanceof Error ? error.name : typeof error);
    console.error('❌ Error message:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Analysis timed out after 30 seconds. Please try again.');
    }
    throw error;
  }
}

export async function askFollowUpQuestion(
  question: string,
  context: { problem: string; solution: string }
): Promise<string> {
  try {
    console.log('Calling API:', `${API_URL}/ask-question`);
    const response = await fetch(`${API_URL}/ask-question`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question, context }),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('API Error Response:', response.status, errorData);
      throw new Error(errorData.error || 'Failed to ask question');
    }
    
    const data = await response.json();
    console.log('API Response received successfully');
    return data.answer;
  } catch (error) {
    console.error('Error asking follow-up question:', error);
    throw error;
  }
}

export async function getSimplifiedExplanations(solution: HomeworkSolution): Promise<SimplifiedExplanation[]> {
  try {
    console.log('Calling API:', `${API_URL}/simplify-explanation`);
    const response = await fetch(`${API_URL}/simplify-explanation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        problem: solution.problem,
        subject: solution.subject,
        difficulty: solution.difficulty,
        steps: solution.steps,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('API Error Response:', response.status, errorData);
      throw new Error(errorData.error || 'Failed to get simplified explanations');
    }
    
    const data = await response.json();
    console.log('Simplified explanations received successfully');
    return data.simplifiedExplanations;
  } catch (error) {
    console.error('Error getting simplified explanations:', error);
    throw error;
  }
}

export async function generateDiagram(description: string): Promise<string> {
  return '';
}

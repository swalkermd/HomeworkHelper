import { HomeworkSolution, SimplifiedExplanation } from '../types';

const API_URL = '/api';

export async function analyzeTextQuestion(question: string): Promise<any> {
  try {
    console.log('📡 Calling API:', `${API_URL}/analyze-text`);
    console.log('📡 Fetch starting...');
    
    const response = await fetch(`${API_URL}/analyze-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question }),
    });
    
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
    throw error;
  }
}

export async function analyzeImageQuestion(imageUri: string, problemNumber?: string): Promise<any> {
  try {
    console.log('Calling API:', `${API_URL}/analyze-image`);
    const response = await fetch(`${API_URL}/analyze-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ imageUri, problemNumber }),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('API Error Response:', response.status, errorData);
      throw new Error(errorData.error || 'Failed to analyze image');
    }
    
    const result = await response.json();
    console.log('✓ Image API Response:', {
      hasSteps: !!result?.steps,
      stepsCount: result?.steps?.length,
      subject: result?.subject,
      difficulty: result?.difficulty,
      hasProblem: !!result?.problem
    });
    return result;
  } catch (error) {
    console.error('❌ Error analyzing image question:', error);
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

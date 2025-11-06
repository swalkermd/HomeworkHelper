const API_URL = 'http://localhost:3000/api';

export async function analyzeTextQuestion(question: string): Promise<any> {
  try {
    const response = await fetch(`${API_URL}/analyze-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to analyze question');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error analyzing text question:', error);
    throw error;
  }
}

export async function analyzeImageQuestion(imageUri: string, problemNumber?: string): Promise<any> {
  try {
    const response = await fetch(`${API_URL}/analyze-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ imageUri, problemNumber }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to analyze image');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error analyzing image question:', error);
    throw error;
  }
}

export async function askFollowUpQuestion(
  question: string,
  context: { problem: string; solution: string }
): Promise<string> {
  try {
    const response = await fetch(`${API_URL}/ask-question`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question, context }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to ask question');
    }
    
    const data = await response.json();
    return data.answer;
  } catch (error) {
    console.error('Error asking follow-up question:', error);
    throw error;
  }
}

export async function generateDiagram(description: string): Promise<string> {
  return '';
}

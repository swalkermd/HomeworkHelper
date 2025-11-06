const API_URL = '/api';

export async function analyzeTextQuestion(question: string): Promise<any> {
  try {
    console.log('Calling API:', `${API_URL}/analyze-text`);
    const response = await fetch(`${API_URL}/analyze-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question }),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('API Error Response:', response.status, errorData);
      throw new Error(errorData.error || 'Failed to analyze question');
    }
    
    const result = await response.json();
    console.log('API Response received successfully');
    return result;
  } catch (error) {
    console.error('Error analyzing text question:', error);
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
    console.log('API Response received successfully');
    return result;
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

export async function generateDiagram(description: string): Promise<string> {
  return '';
}

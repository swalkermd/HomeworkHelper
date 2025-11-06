const getApiUrl = () => {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    
    if (hostname.includes('replit.dev')) {
      const apiHost = hostname.replace('-00-', '-08-');
      return `${protocol}//${apiHost}/api`;
    }
  }
  return 'http://localhost:8080/api';
};

const API_URL = getApiUrl();

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
      const errorData = await response.json().catch(() => ({}));
      console.error('API Error Response:', errorData);
      throw new Error(errorData.error || 'Failed to analyze question');
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
      const errorData = await response.json().catch(() => ({}));
      console.error('API Error Response:', errorData);
      throw new Error(errorData.error || 'Failed to analyze image');
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
      const errorData = await response.json().catch(() => ({}));
      console.error('API Error Response:', errorData);
      throw new Error(errorData.error || 'Failed to ask question');
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

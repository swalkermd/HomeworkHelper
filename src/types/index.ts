export interface HomeworkImage {
  uri: string;
  width: number;
  height: number;
  base64?: string;
  mimeType?: string;
}

export interface SelectedProblem {
  imageUri: string;
  problemArea?: string;
  problemNumber?: string;
}

import { MathNode } from './math';

export interface SolutionStep {
  id: string;
  title: string;
  content: string;
  explanation: string;
  structuredContent?: MathNode[];
  structuredExplanation?: MathNode[];
}

export interface SimplifiedExplanation {
  stepNumber: number;
  simplifiedExplanation: string;
}

export interface HomeworkSolution {
  problem: string;
  subject: string;
  difficulty: string;
  steps: SolutionStep[];
  finalAnswer: string;
  problemStructured?: MathNode[];
  finalAnswerStructured?: MathNode[];
  solutionId?: string;
  verificationStatus?: 'pending' | 'verified' | 'unverified';
  verificationConfidence?: number;
  verificationWarnings?: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export type Subject = 'Math' | 'Chemistry' | 'Physics' | 'Bible Studies' | 'Language Arts' | 'Geography' | 'General';
export type Difficulty = 'K-5' | '6-8' | '9-12' | 'College+';

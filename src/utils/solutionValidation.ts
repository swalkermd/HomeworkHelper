import { HomeworkSolution } from '../types';

export interface SolutionValidationIssue {
  code: 'missing-problem' | 'missing-steps' | 'missing-final-answer' | 'empty-step-content';
  message: string;
}

export interface SolutionValidationResult {
  isValid: boolean;
  issues: SolutionValidationIssue[];
}

export function validateSolutionIntegrity(solution: HomeworkSolution | null | undefined): SolutionValidationResult {
  const issues: SolutionValidationIssue[] = [];

  if (!solution) {
    issues.push({
      code: 'missing-problem',
      message: 'No solution data was provided.',
    });
    return { isValid: false, issues };
  }

  if (!solution.problem?.trim()) {
    issues.push({
      code: 'missing-problem',
      message: 'The original problem statement is missing.',
    });
  }

  if (!solution.steps || solution.steps.length === 0) {
    issues.push({
      code: 'missing-steps',
      message: 'The solution does not contain any steps.',
    });
  } else if (solution.steps.some((step) => !step.content?.trim())) {
    issues.push({
      code: 'empty-step-content',
      message: 'One or more steps are missing an explanation.',
    });
  }

  if (!solution.finalAnswer?.trim()) {
    issues.push({
      code: 'missing-final-answer',
      message: 'A final answer was not provided.',
    });
  }

  return {
    isValid: issues.length === 0,
    issues,
  };
}

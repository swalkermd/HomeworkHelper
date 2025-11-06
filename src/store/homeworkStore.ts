import { create } from 'zustand';
import { HomeworkImage, SelectedProblem, HomeworkSolution } from '../types';

interface HomeworkStore {
  currentImage: HomeworkImage | null;
  selectedProblem: SelectedProblem | null;
  currentSolution: HomeworkSolution | null;
  isAnalyzing: boolean;
  
  setCurrentImage: (image: HomeworkImage | null) => void;
  setSelectedProblem: (problem: SelectedProblem | null) => void;
  setCurrentSolution: (solution: HomeworkSolution | null) => void;
  setIsAnalyzing: (analyzing: boolean) => void;
  reset: () => void;
}

export const useHomeworkStore = create<HomeworkStore>((set) => ({
  currentImage: null,
  selectedProblem: null,
  currentSolution: null,
  isAnalyzing: false,

  setCurrentImage: (image) => set({ currentImage: image }),
  setSelectedProblem: (problem) => set({ selectedProblem: problem }),
  setCurrentSolution: (solution) => set({ currentSolution: solution }),
  setIsAnalyzing: (analyzing) => set({ isAnalyzing: analyzing }),
  reset: () => set({
    currentImage: null,
    selectedProblem: null,
    currentSolution: null,
    isAnalyzing: false,
  }),
}));

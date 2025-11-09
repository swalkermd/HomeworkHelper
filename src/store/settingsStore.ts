import { create } from 'zustand';

interface SettingsStore {
  showStepExplanations: boolean;
  
  setShowStepExplanations: (show: boolean) => void;
  reset: () => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  showStepExplanations: true,

  setShowStepExplanations: (show) => set({ showStepExplanations: show }),
  reset: () => set({
    showStepExplanations: true,
  }),
}));

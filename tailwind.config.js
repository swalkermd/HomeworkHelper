/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./App.{js,jsx,ts,tsx}",
    "./src/**/*.{js,jsx,ts,tsx}"
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        primary: "#6366f1",
        secondary: "#10b981",
        textPrimary: "#111827",
        textSecondary: "#6b7280",
        background: "#f9fafb",
        surfaceAlt: "#f3f4f6",
        border: "#e5e7eb",
      },
    },
  },
  plugins: [],
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        fruite: { green: '#1b7a3d', dark: '#0f5226' },
      },
    },
  },
  plugins: [],
}

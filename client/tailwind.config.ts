import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#15202b',
        line: '#d8dee8',
        surface: '#f7f9fc'
      }
    }
  },
  plugins: []
} satisfies Config;

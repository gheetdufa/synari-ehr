/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0fdfa',
          100: '#ccfbf1',
          200: '#99f6e4',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
        },
        sage: {
          50: '#f6f7f6',
          100: '#e3e7e3',
          200: '#c7d2c7',
          300: '#a3b5a3',
          400: '#7a927a',
          500: '#5c755c',
          600: '#475e47',
          700: '#3a4d3a',
          800: '#2f3f2f',
          900: '#283428',
        },
        warm: {
          50: '#fefdf8',
          100: '#fefbf0',
          200: '#fdf4d9',
          300: '#fbe9b8',
          400: '#f7d97b',
          500: '#f2c94c',
          600: '#e6b532',
          700: '#d19b1f',
          800: '#b8821c',
          900: '#996b1a',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fade-in 0.5s ease-out forwards',
        'slide-up': 'slide-up 0.5s ease-out forwards',
        'slide-in-right': 'slide-in-right 0.5s ease-out forwards',
        'slide-in-left': 'slide-in-left 0.5s ease-out forwards',
        'scale-in': 'scale-in 0.5s ease-out forwards',
        'float': 'float 3s ease-in-out infinite',
        'pulse-subtle': 'pulse-subtle 2s ease-in-out infinite',
        'typing-animation': 'typing 2s cubic-bezier(0.4, 0, 0.2, 1) forwards',
        'hero-badge': 'heroBadge 0.5s ease-out forwards',
        'hero-title': 'heroTitle 0.5s ease-out forwards',
        'hero-description': 'heroDescription 0.5s ease-out forwards',
        'hero-buttons': 'heroButtons 0.5s ease-out forwards',
        'hero-card-1': 'heroCard1 0.5s ease-out forwards',
        'hero-card-2': 'heroCard2 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards 0.8s',
        'hero-card-3': 'heroCard3 1s ease-out forwards 2s',
        'section-fade-in': 'sectionFadeIn 0.8s ease-out forwards',
        'section-slide-in': 'sectionSlideIn 0.8s ease-out forwards',
        'section-scale-in': 'sectionScaleIn 0.8s ease-out forwards',
        'section-rotate-in': 'sectionRotateIn 0.8s ease-out forwards',
        'section-bounce-in': 'sectionBounceIn 1s cubic-bezier(0.68, -0.55, 0.265, 1.55) forwards'
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        'slide-up': {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' }
        },
        'slide-in-left': {
          '0%': { transform: 'translateX(-20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' }
        },
        'scale-in': {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' }
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' }
        },
        'pulse-subtle': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.05)' }
        },
        'typing': {
          '0%': { width: '0', opacity: '0' },
          '10%': { opacity: '1' },
          '100%': { width: '100%', opacity: '1' }
        },
        'blink': {
          '50%': { borderColor: 'transparent' }
        },
        'heroBadge': {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        },
        'heroTitle': {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        },
        'heroDescription': {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        },
        'heroButtons': {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        },
        'heroCard1': {
          '0%': { transform: 'translateX(20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' }
        },
        'heroCard2': {
          '0%': { transform: 'translateY(20px) scale(0.95)', opacity: '0', visibility: 'hidden' },
          '1%': { visibility: 'visible' },
          '100%': { transform: 'translateY(0) scale(1)', opacity: '1', visibility: 'visible' }
        },
        'heroCard3': {
          '0%': { transform: 'translateY(-20px)', opacity: '0', visibility: 'hidden' },
          '1%': { visibility: 'visible' },
          '100%': { transform: 'translateY(0)', opacity: '1', visibility: 'visible' }
        },
        'sectionFadeIn': {
          '0%': { opacity: '0', transform: 'translateY(30px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        'sectionSlideIn': {
          '0%': { transform: 'translateX(-50px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' }
        },
        'sectionScaleIn': {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' }
        },
        'sectionRotateIn': {
          '0%': { transform: 'rotate(-5deg) scale(0.95)', opacity: '0' },
          '100%': { transform: 'rotate(0) scale(1)', opacity: '1' }
        },
        'sectionBounceIn': {
          '0%': { transform: 'scale(0.3)', opacity: '0' },
          '50%': { transform: 'scale(1.05)', opacity: '0.8' },
          '70%': { transform: 'scale(0.9)', opacity: '0.9' },
          '100%': { transform: 'scale(1)', opacity: '1' }
        }
      },
    },
  },
  plugins: [],
};
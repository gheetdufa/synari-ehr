import React, { useState, useEffect } from 'react';
import { Menu, X, Lock, LogIn } from 'lucide-react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAnalytics } from '../lib/analytics';
import { Brand } from './BrandMark';
import './brand-mark.css';

const Header = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { trackCTAClick } = useAnalytics();
  
  // Check if we're on the home page
  const isHomePage = location.pathname === '/';

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleLogoClick = (e: React.MouseEvent) => {
    e.preventDefault();
    navigate('/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <header className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      isHomePage 
        ? (isScrolled 
            ? 'bg-white/95 backdrop-blur-sm border-b border-sage-100' 
            : 'bg-transparent')
        : 'bg-white/95 backdrop-blur-sm border-b border-sage-100'
    }`}>
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <div className="flex items-center">
            <div className="flex-shrink-0 flex items-center">
              <Link to="/" onClick={handleLogoClick} className="flex items-center">
                <Brand wordClassName={`text-lg font-bold tracking-tight ${
                  isHomePage && !isScrolled ? 'text-white bg-none [-webkit-text-fill-color:white]' : 'brand-word'
                }`} />
              </Link>
            </div>
          </div>

          {/* HIPAA Trust Signal & CTA */}
          <div className="hidden md:flex items-center space-x-4">
            <div className={`flex items-center space-x-1 text-sm transition-colors duration-300 ${
              isHomePage && !isScrolled ? 'text-white' : 'text-sage-600'
            }`}>
              <Lock className="w-4 h-4" />
              <span>HIPAA Compliant</span>
            </div>
            <Link 
              to="/about" 
              onClick={() => trackCTAClick('About Us', 'Header')} 
              className={`px-4 py-2 rounded-lg transition-all duration-300 ${
                isHomePage && !isScrolled
                  ? 'bg-white/20 text-white hover:bg-white/30 backdrop-blur-sm'
                  : 'bg-sage-100 text-sage-800 hover:bg-sage-200'
              }`}
            >
              About Us
            </Link>
            <Link 
              to="/features" 
              onClick={() => trackCTAClick('Learn More', 'Header')} 
              className={`px-4 py-2 rounded-lg transition-all duration-300 ${
                isHomePage && !isScrolled
                  ? 'bg-white/20 text-white hover:bg-white/30 backdrop-blur-sm'
                  : 'bg-sage-100 text-sage-800 hover:bg-sage-200'
              }`}
            >
              Learn More
            </Link>
            <Link
              to="/demo"
              onClick={() => trackCTAClick('Get a Demo', 'Header')}
              className="bg-gradient-to-r from-[#0e8177] to-primary-700 text-white px-4 py-2 rounded-lg hover:brightness-110 transition-all"
            >
              Get a Demo
            </Link>
            <Link
              to="/login"
              onClick={() => trackCTAClick('Login', 'Header')}
              className={`flex items-center space-x-1 px-4 py-2 rounded-lg transition-all duration-300 ${
                isHomePage && !isScrolled
                  ? 'bg-white/20 text-white hover:bg-white/30 backdrop-blur-sm'
                  : 'bg-sage-50 text-sage-700 hover:bg-sage-100 border border-sage-200'
              }`}
            >
              <LogIn className="w-4 h-4" />
              <span>Login</span>
            </Link>
          </div>

          {/* Mobile menu button */}
          <div className="md:hidden">
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className={`transition-colors duration-300 ${
                isHomePage && !isScrolled ? 'text-white hover:text-white/80' : 'text-sage-700 hover:text-primary-600'
              }`}
            >
              {isMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {isMenuOpen && (
          <div className="md:hidden absolute top-full left-0 right-0 mx-4 mt-2 rounded-2xl border border-gray-200 bg-white shadow-2xl">
            <nav className="flex flex-col p-6 space-y-4">
              <div className="flex items-center justify-center space-x-2 text-sm text-gray-600 pb-4 border-b border-gray-200">
                <Lock className="w-4 h-4" />
                <span>HIPAA Compliant</span>
              </div>
              <div className="flex flex-col space-y-3">
                <Link 
                  to="/about"
                  onClick={() => setIsMenuOpen(false)}
                  className="px-6 py-3 rounded-full text-center bg-gray-50 text-gray-800 hover:bg-gray-100 border border-gray-200 transition-all duration-300 font-normal"
                >
                  About Us
                </Link>
                <Link 
                  to="/features"
                  onClick={() => setIsMenuOpen(false)}
                  className="px-6 py-3 rounded-full text-center bg-gray-50 text-gray-800 hover:bg-gray-100 border border-gray-200 transition-all duration-300 font-normal"
                >
                  Learn More
                </Link>
                <Link
                  to="/demo"
                  onClick={() => setIsMenuOpen(false)}
                  className="px-6 py-3 rounded-full text-center bg-gradient-to-r from-[#0e8177] to-primary-700 text-white hover:brightness-110 transition-all duration-300 font-normal shadow-lg"
                >
                  Get a Demo
                </Link>
                <Link
                  to="/login"
                  onClick={() => setIsMenuOpen(false)}
                  className="px-6 py-3 rounded-full text-center bg-white text-gray-700 hover:bg-gray-50 border border-gray-300 transition-all duration-300 font-normal flex items-center justify-center space-x-2"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Login</span>
                </Link>
              </div>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;

// hehe

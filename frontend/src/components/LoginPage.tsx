import React, { useState, useEffect } from 'react';
import { useStaffAuth } from '../auth/StaffAuth';
import { MfaCodeForm } from '../auth/MfaCodeForm';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence, Variants } from 'framer-motion';
import { ArrowRight, UserPlus } from 'lucide-react';
import { Brand } from './BrandMark';
import './brand-mark.css';

const bubbleDetails = Array.from({ length: 15 }).map(() => ({
  left: `${Math.random() * 100}%`,
  size: `${Math.random() * 60 + 20}px`,
  duration: `${Math.random() * 10 + 8}s`,
  delay: `${Math.random() * 5}s`,
}));

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.3,
    },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
    },
  },
};

const LoginPage: React.FC = () => {
  const { login, completeMfa, status } = useStaffAuth();
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const isAuthenticated = status === 'signedIn';
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as { from?: string; reason?: string } | null;
  const from = routeState?.from ?? '/portal';
  const signedOutForInactivity = routeState?.reason === 'idle';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(signedOutForInactivity);

  useEffect(() => {
    if (isAuthenticated) {
      navigate(from, { replace: true });
    }
  }, [isAuthenticated, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const challenge = await login(email, password);
      if (challenge) {
        setMfaToken(challenge.mfaToken);
        setIsLoading(false);
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
      setIsLoading(false);
    }
  };

  return (
    <>
      <style>{`
        @keyframes float {
          0% {
            transform: translateY(0) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(-110vh) rotate(360deg);
            opacity: 0;
          }
        }
      `}</style>
      <div className="synari-marketing min-h-screen w-full bg-gradient-to-br from-teal-600 to-teal-900 flex flex-col justify-center items-center p-8 text-white overflow-hidden relative">
        {/* Floating Bubbles Background */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
          {bubbleDetails.map((style, index) => (
            <div
              key={index}
              className="absolute bottom-[-100px] bg-white/10 rounded-full"
              style={{
                left: style.left,
                width: style.size,
                height: style.size,
                animation: `float ${style.duration} ${style.delay} linear infinite`,
              }}
            />
          ))}
        </div>
        <motion.div
          className="text-center z-10 flex flex-col items-center"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div variants={itemVariants} className="mb-4 flex justify-center [&_.stack-mark]:w-16">
            <Brand withWord={false} />
          </motion.div>
          <motion.h1
            variants={itemVariants}
            className="text-5xl md:text-6xl font-bold mb-4"
          >
            Welcome to <span className="text-teal-200">Synari</span>
          </motion.h1>
          <motion.p variants={itemVariants} className="text-lg max-w-xl mx-auto opacity-90 mb-12">
            Your AI-powered practice assistant.
          </motion.p>
          <motion.div variants={itemVariants} className="flex flex-col sm:flex-row gap-4 justify-center">
            <button
              className="w-full sm:w-auto bg-white text-teal-600 font-bold py-3 px-8 rounded-lg shadow-lg hover:bg-gray-100 transition-colors duration-300 flex items-center justify-center gap-2"
              onClick={() => setShowLogin(true)}
            >
              <ArrowRight className="w-5 h-5" />
              Log In
            </button>
            <Link to="/register">
              <button className="w-full sm:w-auto bg-transparent border-2 border-white text-white font-bold py-3 px-8 rounded-lg hover:bg-white/10 transition-colors duration-300 flex items-center justify-center gap-2">
                <UserPlus className="w-5 h-5" />
                Register
              </button>
            </Link>
          </motion.div>
        </motion.div>
        {/* Login Modal */}
        <AnimatePresence>
          {showLogin && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-30 flex items-center justify-center bg-black/40"
              onClick={() => setShowLogin(false)}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8 relative text-sage-900"
                onClick={e => e.stopPropagation()}
              >
                <button
                  className="absolute top-4 right-4 text-sage-400 hover:text-teal-600 text-2xl"
                  onClick={() => setShowLogin(false)}
                  aria-label="Close"
                >
                  ×
                </button>
                <h2 className="text-2xl font-bold text-teal-700 mb-2 text-center">Sign in to Synari</h2>
                {mfaToken ? (
                  <MfaCodeForm
                    onSubmit={async (code) => {
                      await completeMfa(mfaToken, code);
                      navigate(from, { replace: true });
                    }}
                    onCancel={() => {
                      setMfaToken(null);
                      setPassword('');
                    }}
                  />
                ) : (
                <form className="space-y-5" onSubmit={handleSubmit}>
                  {signedOutForInactivity && !error && (
                    <div className="bg-sky-50 border border-sky-200 text-sky-900 px-4 py-3 rounded text-sm">
                      You were signed out after a period of inactivity to protect client privacy.
                    </div>
                  )}
                  {error && (
                    <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
                      {error}
                    </div>
                  )}
                  <div>
                    <label htmlFor="email" className="block text-sm font-medium text-sage-700">
                      Email address
                    </label>
                    <input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      className="mt-1 block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-500 sm:text-sm bg-white shadow-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="password" className="block text-sm font-medium text-sage-700">
                      Password
                    </label>
                    <input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      className="mt-1 block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-emerald-500 sm:text-sm bg-white shadow-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full flex justify-center py-2 px-4 border border-transparent rounded-lg shadow-md text-sm font-semibold text-white bg-gradient-to-r from-teal-500 to-emerald-500 hover:from-teal-600 hover:to-emerald-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  >
                    {isLoading ? 'Signing in...' : 'Sign in'}
                  </button>
                </form>
                )}
                <div className="mt-6 flex flex-col items-center gap-2 text-sm">
                  <Link to="/forgot-password" className="font-medium text-teal-700 hover:underline">
                    Forgot your password?
                  </Link>
                  <Link to="/client/sign-in" className="text-sage-600 hover:underline">
                    Are you a client? Sign in to the client portal
                  </Link>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
};

export default LoginPage; 
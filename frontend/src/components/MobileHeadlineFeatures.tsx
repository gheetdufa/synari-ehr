import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Brain, FileText, DollarSign, Calendar, Users, Shield, 
  Sparkles, CheckCircle, ArrowRight, Play,
  BarChart3, Megaphone, 
  ChevronLeft, ChevronRight, Clock, Zap
} from 'lucide-react';
import { Link } from 'react-router-dom';
import Header from './Header';
import Footer from './Footer';

const MobileHeadlineFeatures = () => {
  const [currentFeatureIndex, setCurrentFeatureIndex] = useState(0);

  // Core features data
  const features = [
    {
      icon: Brain,
      title: "AI Session Assistant",
      description: "Real-time analysis and insights during sessions",
      stats: "95% accuracy",
      color: "purple",
      benefits: [
        "Live sentiment analysis during sessions",
        "AI-powered treatment recommendations", 
        "Automatic session summaries and notes",
        "Pattern recognition across sessions"
      ]
    },
    {
      icon: FileText,
      title: "Smart Documentation",
      description: "Automated SOAP notes and treatment plans",
      stats: "90% time saved",
      color: "blue",
      benefits: [
        "Auto-generated SOAP notes",
        "Treatment plan suggestions",
        "Progress tracking automation",
        "Compliance documentation"
      ]
    },
    {
      icon: DollarSign,
      title: "Intelligent Billing",
      description: "Automated billing and insurance processing",
      stats: "100% compliant",
      color: "green",
      benefits: [
        "Instant superbill generation",
        "Insurance claim automation",
        "Payment tracking and reminders",
        "Revenue analytics and reporting"
      ]
    },
    {
      icon: Calendar,
      title: "Smart Scheduling",
      description: "AI-optimized appointment management",
      stats: "70% fewer no-shows",
      color: "orange",
      benefits: [
        "Intelligent scheduling optimization",
        "Automated appointment reminders",
        "No-show prediction and prevention",
        "Calendar integration and sync"
      ]
    }
  ];

  // Marketing features
  const marketingFeatures = [
    {
      icon: Megaphone,
      title: "Content Creation",
      description: "AI-generated marketing content and campaigns",
      stats: "5x engagement",
      color: "pink"
    },
    {
      icon: Users,
      title: "Client Acquisition",
      description: "Targeted marketing to attract ideal clients",
      stats: "3x leads",
      color: "purple"
    },
    {
      icon: BarChart3,
      title: "Analytics & Insights",
      description: "Track marketing performance and ROI",
      stats: "2x conversion",
      color: "blue"
    }
  ];

  // Touch handling for swipe gestures
  const handleSwipe = (direction: 'left' | 'right') => {
    setCurrentFeatureIndex((prev) =>
      direction === 'left' ? (prev + 1) % features.length : (prev - 1 + features.length) % features.length,
    );
  };

  const getFeatureColors = (color: string) => {
    const colorMap = {
      purple: { bg: 'from-purple-400 to-purple-600', accent: 'purple', badge: 'bg-purple-100 text-purple-700' },
      blue: { bg: 'from-blue-400 to-blue-600', accent: 'blue', badge: 'bg-blue-100 text-blue-700' },
      green: { bg: 'from-green-400 to-green-600', accent: 'green', badge: 'bg-green-100 text-green-700' },
      orange: { bg: 'from-orange-400 to-orange-600', accent: 'orange', badge: 'bg-orange-100 text-orange-700' },
      pink: { bg: 'from-pink-400 to-pink-600', accent: 'pink', badge: 'bg-pink-100 text-pink-700' }
    };
    return colorMap[color as keyof typeof colorMap] ?? colorMap.purple;
  };

  return (
    <div className="lg:hidden min-h-screen bg-white">
      <Header />
      
      {/* Hero Section */}
      <section className="relative h-screen flex items-center justify-center overflow-hidden pt-16">
        <motion.img
          src="/new-hero-bg.jpeg"
          alt="Background"
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-black/40 z-10" />
        
        <div className="relative z-20 w-full px-6 text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            className="mb-6"
          >
            <div className="inline-flex items-center space-x-2 bg-white/20 backdrop-blur-sm text-white px-4 py-2 rounded-full text-sm font-medium mb-4">
              <Sparkles className="w-4 h-4" />
              <span>SYNARI Features</span>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="text-center mb-8"
          >
            <h1 className="text-4xl font-normal text-white mb-4 leading-tight">
              Automate Your Practice with{' '}
              <span className="bg-gradient-to-r from-teal-300 to-cyan-300 bg-clip-text text-transparent">
                AI-Powered Management
              </span>
            </h1>
            <p className="text-white/90 text-lg mb-8 max-w-sm mx-auto">
              From intake to billing, documentation to marketing - AI handles the busywork.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.4 }}
            className="space-y-4"
          >
            <Link
              to="/demo"
              className="inline-block px-8 py-4 bg-white text-gray-900 rounded-full font-semibold shadow-lg hover:shadow-xl transition-all w-full text-center max-w-sm"
            >
              Get a Demo
            </Link>
            <div className="flex items-center justify-center space-x-6 text-white/80 text-sm">
              <div className="flex items-center space-x-2">
                <Clock className="w-4 h-4" />
                <span>5 min setup</span>
              </div>
              <div className="flex items-center space-x-2">
                <Shield className="w-4 h-4" />
                <span>HIPAA secure</span>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Core Features Section */}
      <section className="relative py-16 overflow-hidden bg-gradient-to-br from-gray-50 via-blue-50 to-teal-50">
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden">
          <motion.div
            className="absolute -top-40 -right-40 w-80 h-80 rounded-full bg-teal-200/30"
            animate={{ rotate: 360, scale: [1, 1.1, 1] }}
            transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          />
          <motion.div
            className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-blue-200/20"
            animate={{ rotate: -360, scale: [1, 1.2, 1] }}
            transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
          />
        </div>
        <div className="absolute inset-0 bg-white/30 z-10" />
        
        <div className="relative z-20 px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center mb-12"
          >
            <div className="inline-flex items-center space-x-2 bg-teal-500/20 backdrop-blur-sm text-teal-700 px-4 py-2 rounded-full text-sm font-medium mb-4 border border-teal-200/50">
              <Brain className="w-4 h-4" />
              <span>Core Features</span>
            </div>
            <h2 className="text-3xl font-normal text-gray-800 mb-4">
              Everything You Need in{' '}
              <span className="bg-gradient-to-r from-teal-600 to-emerald-600 bg-clip-text text-transparent">
                One Platform
              </span>
            </h2>
            <p className="text-gray-600 text-lg max-w-sm mx-auto">
              Powerful AI features designed specifically for therapy practices.
            </p>
          </motion.div>

          {/* Swipeable Feature Cards */}
          <div className="mb-8">
            <div className="relative">
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentFeatureIndex}
                  initial={{ opacity: 0, x: 0 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 0 }}
                  transition={{ duration: 0.3 }}
                  className="bg-white/70 backdrop-blur-sm rounded-2xl p-8 border border-gray-200/50 shadow-lg"
                >
                  <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-6 ${
                    features[currentFeatureIndex].color === 'purple' ? 'bg-gradient-to-br from-purple-400 to-purple-600' :
                    features[currentFeatureIndex].color === 'blue' ? 'bg-gradient-to-br from-blue-400 to-blue-600' :
                    features[currentFeatureIndex].color === 'green' ? 'bg-gradient-to-br from-green-400 to-green-600' :
                    'bg-gradient-to-br from-orange-400 to-orange-600'
                  }`}>
                    {React.createElement(features[currentFeatureIndex].icon, { 
                      className: "w-8 h-8 text-white" 
                    })}
                  </div>
                  
                  <h3 className="text-2xl font-normal text-gray-800 mb-3">
                    {features[currentFeatureIndex].title}
                  </h3>
                  <p className="text-gray-600 text-lg mb-4">
                    {features[currentFeatureIndex].description}
                  </p>
                  
                  <div className={`inline-flex items-center space-x-2 px-3 py-2 rounded-full text-sm font-medium mb-6 ${
                    features[currentFeatureIndex].color === 'purple' ? 'bg-purple-100 text-purple-700' :
                    features[currentFeatureIndex].color === 'blue' ? 'bg-blue-100 text-blue-700' :
                    features[currentFeatureIndex].color === 'green' ? 'bg-green-100 text-green-700' :
                    'bg-orange-100 text-orange-700'
                  }`}>
                    <CheckCircle className="w-4 h-4" />
                    <span>{features[currentFeatureIndex].stats}</span>
                  </div>

                  {/* Benefits */}
                  <div className="space-y-3">
                    {features[currentFeatureIndex].benefits.map((benefit, index) => (
                      <div key={index} className="flex items-start space-x-3">
                        <CheckCircle className="w-5 h-5 text-teal-600 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-700 text-sm">{benefit}</span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Navigation */}
            <div className="flex items-center justify-between mt-6">
              <button
                onClick={() => handleSwipe('right')}
                className="p-3 bg-white/60 backdrop-blur-sm rounded-full border border-gray-200/50 shadow-lg"
              >
                <ChevronLeft className="w-5 h-5 text-gray-600" />
              </button>
              
              <div className="flex space-x-2">
                {features.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => setCurrentFeatureIndex(index)}
                    className={`h-2 rounded-full transition-all duration-300 ${
                      index === currentFeatureIndex ? 'bg-teal-600 w-8' : 'bg-gray-400 w-2'
                    }`}
                  />
                ))}
              </div>
              
              <button
                onClick={() => handleSwipe('left')}
                className="p-3 bg-white/60 backdrop-blur-sm rounded-full border border-gray-200/50 shadow-lg"
              >
                <ChevronRight className="w-5 h-5 text-gray-600" />
              </button>
            </div>
          </div>

          {/* CTA */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="text-center"
          >
            <p className="text-gray-600 text-sm mb-6">
              Ready to transform your practice with AI?
            </p>
            <Link
              to="/demo"
              className="inline-flex items-center justify-center space-x-2 bg-teal-500/20 backdrop-blur-sm text-teal-700 px-8 py-4 rounded-full border border-teal-300/50 hover:bg-teal-500/30 transition-all font-normal"
            >
              <Play className="w-4 h-4" />
              <span>See Features in Action</span>
            </Link>
          </motion.div>
        </div>
      </section>

      {/* Marketing AI Section */}
      <section className="relative py-16 overflow-hidden bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50">
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden">
          <motion.div
            className="absolute top-20 right-20 w-64 h-64 rounded-full bg-purple-200/20"
            animate={{ rotate: -360, y: [0, -20, 0] }}
            transition={{ duration: 15, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="absolute bottom-20 left-20 w-72 h-72 rounded-full bg-pink-200/15"
            animate={{ rotate: 360, x: [0, 20, 0] }}
            transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
        <div className="absolute inset-0 bg-white/40 z-10" />
        
        <div className="relative z-20 px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center mb-12"
          >
            <div className="inline-flex items-center space-x-2 bg-purple-500/20 backdrop-blur-sm text-purple-700 px-4 py-2 rounded-full text-sm font-medium mb-4 border border-purple-200/50">
              <Megaphone className="w-4 h-4" />
              <span>Marketing AI</span>
            </div>
            <h2 className="text-3xl font-normal text-gray-800 mb-4">
              Grow Your Practice with{' '}
              <span className="bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
                AI Marketing
              </span>
            </h2>
            <p className="text-gray-600 text-lg max-w-sm mx-auto">
              Let AI handle your marketing while you focus on clients.
            </p>
          </motion.div>

          {/* Marketing Feature Grid */}
          <div className="grid gap-6 mb-8">
            {marketingFeatures.map((feature, index) => {
              const colors = getFeatureColors(feature.color);
              return (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  className="bg-white/70 backdrop-blur-sm rounded-2xl p-6 border border-gray-200/50 shadow-lg"
                >
                  <div className="flex items-start space-x-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center bg-gradient-to-br ${colors.bg}`}>
                      {React.createElement(feature.icon, { 
                        className: "w-6 h-6 text-white" 
                      })}
                    </div>
                    <div className="flex-1">
                      <h3 className="text-lg font-medium text-gray-800 mb-2">
                        {feature.title}
                      </h3>
                      <p className="text-gray-600 text-sm mb-3">
                        {feature.description}
                      </p>
                      <div className={`inline-flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-medium ${colors.badge}`}>
                        <Zap className="w-3 h-3" />
                        <span>{feature.stats}</span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* CTA */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="text-center"
          >
            <p className="text-gray-600 text-sm mb-6">
              Ready to grow your practice with AI marketing?
            </p>
            <Link
              to="/demo"
              className="inline-flex items-center justify-center space-x-2 bg-gradient-to-r from-purple-500/20 to-pink-500/20 backdrop-blur-sm text-purple-700 px-8 py-4 rounded-full border border-purple-300/50 hover:from-purple-500/30 hover:to-pink-500/30 transition-all font-normal"
            >
              <Megaphone className="w-4 h-4" />
              <span>Learn More</span>
            </Link>
          </motion.div>
        </div>
      </section>

      {/* Final CTA Section */}
      <section className="relative py-20 overflow-hidden bg-gradient-to-br from-gray-900 via-teal-900 to-emerald-900">
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden">
          <motion.div
            className="absolute top-10 left-10 w-32 h-32 rounded-full bg-teal-400/20"
            animate={{ rotate: 360, scale: [1, 1.2, 1] }}
            transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          />
          <motion.div
            className="absolute bottom-10 right-10 w-40 h-40 rounded-full bg-emerald-400/15"
            animate={{ rotate: -360, y: [0, -30, 0] }}
            transition={{ duration: 25, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
        <div className="absolute inset-0 bg-black/40 z-10" />
        
        <div className="relative z-20 px-6 text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            className="max-w-md mx-auto"
          >
            <div className="inline-flex items-center space-x-2 bg-white/20 backdrop-blur-sm text-white px-4 py-2 rounded-full text-sm font-medium mb-6">
              <Sparkles className="w-4 h-4" />
              <span>Ready to Get Started?</span>
            </div>
            
            <h2 className="text-4xl font-normal text-white mb-6 leading-tight">
              Transform Your Practice{' '}
              <span className="bg-gradient-to-r from-teal-300 to-cyan-300 bg-clip-text text-transparent">
                Today
              </span>
            </h2>
            
            <p className="text-white/90 text-lg mb-8">
              Join hundreds of therapists who've automated their practice with Synari.
            </p>
            
            <div className="space-y-4">
              <Link
                to="/demo"
                className="inline-flex items-center justify-center space-x-3 bg-white text-gray-900 px-8 py-4 rounded-full font-semibold shadow-2xl hover:shadow-3xl transition-all w-full"
              >
                <Play className="w-5 h-5" />
                <span>Schedule Your Demo</span>
                <ArrowRight className="w-5 h-5" />
              </Link>
              
              <div className="flex items-center justify-center space-x-6 text-white/80 text-sm">
                <div className="flex items-center space-x-2">
                  <Clock className="w-4 h-4" />
                  <span>5 min setup</span>
                </div>
                <div className="flex items-center space-x-2">
                  <Shield className="w-4 h-4" />
                  <span>HIPAA secure</span>
                </div>
                <div className="flex items-center space-x-2">
                  <Zap className="w-4 h-4" />
                  <span>No credit card</span>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>
      
      <Footer />
    </div>
  );
};

export default MobileHeadlineFeatures; 
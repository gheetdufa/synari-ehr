import { useEffect } from 'react';
import { Sparkles, Clock, Shield, Brain, Zap, ArrowRight, Megaphone, BarChart2, Target, FileText, Calendar, CreditCard, MessageSquare, Activity, Lightbulb, CheckCircle, ChevronRight } from 'lucide-react';
import { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion, Variants } from 'framer-motion';
import Header from './Header';
import MobileHeadlineFeatures from './MobileHeadlineFeatures';
import './brand-mark.css';

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
  benefits: string[];
  visual: 'left' | 'right';
  color?: string;
}

const HeadlineFeatures = () => {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        duration: 0.8,
        staggerChildren: 0.2,
        delayChildren: 0.3
      }
    }
  };

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.6,
        ease: [0.21, 0.47, 0.32, 0.98]
      }
    }
  };

  const visualVariants: Variants = {
    hidden: { opacity: 0, x: -50 },
    visible: {
      opacity: 1,
      x: 0,
      transition: {
        duration: 0.8,
        ease: [0.21, 0.47, 0.32, 0.98]
      }
    }
  };

  const features: Feature[] = [
    {
      icon: Brain,
      title: "AI-Powered Documentation",
      description: "Automatically generate comprehensive session notes using advanced AI, saving you hours of documentation time while maintaining clinical accuracy.",
      benefits: [
        "90% reduction in documentation time",
        "Context-aware note generation",
        "Customizable templates for different therapy types",
        "Automatic SOAP note formatting"
      ],
      visual: "left",
      color: "purple"
    },
    {
      icon: Clock,
      title: "Time-Saving Automation",
      description: "Let AI handle the routine tasks while you focus on what matters most - your clients.",
      benefits: [
        "Automated appointment scheduling",
        "Smart calendar optimization",
        "Intelligent waitlist management",
        "Automated follow-up reminders"
      ],
      visual: "right",
      color: "blue"
    },
    {
      icon: Shield,
      title: "Enhanced Security & Compliance",
      description: "Built-in HIPAA compliance with AI-powered security features that protect your practice and client data.",
      benefits: [
        "Real-time compliance monitoring",
        "Automated risk assessment",
        "Secure data encryption",
        "Regular compliance reporting"
      ],
      visual: "left",
      color: "green"
    },
    {
      icon: Zap,
      title: "Smart Practice Management",
      description: "AI-driven insights and automation to optimize your practice operations and client care.",
      benefits: [
        "Predictive analytics for no-shows",
        "Automated insurance verification",
        "Smart billing and claims processing",
        "Practice performance insights"
      ],
      visual: "right",
      color: "orange"
    }
  ];

  const marketingFeatures: Feature[] = [
    {
      icon: Megaphone,
      title: "AI-Powered Marketing",
      description: "Let our AI create and optimize your marketing campaigns to attract your ideal clients.",
      benefits: [
        "Automated social media content generation",
        "SEO-optimized website content",
        "Personalized email campaigns",
        "Performance analytics"
      ],
      visual: "left",
      color: "pink"
    },
    {
      icon: Target,
      title: "Smart Client Acquisition",
      description: "Target and attract your ideal clients with data-driven marketing strategies.",
      benefits: [
        "Demographic-based targeting",
        "Specialty-specific campaigns",
        "Local SEO optimization",
        "Competitor analysis"
      ],
      visual: "right",
      color: "teal"
    }
  ];

  const renderFeatureVisual = (feature: Feature) => {
    switch (feature.title) {
      case "AI-Powered Documentation":
        return (
          <motion.div 
            variants={visualVariants}
            className="flex-1 bg-white/95 backdrop-blur-sm rounded-2xl p-8 border border-sage-100 shadow-xl"
          >
            <div className="space-y-6">
              <div className="flex items-center space-x-3 mb-6">
                <Sparkles className="w-5 h-5 text-primary-600" />
                <span className="text-base font-medium text-primary-700">AI Note Generation</span>
              </div>
              <div className="bg-sage-50 rounded-xl p-6 space-y-4">
                <div className="flex items-center space-x-3">
                  <FileText className="w-5 h-5 text-sage-600" />
                  <div className="h-4 bg-sage-200 rounded-lg w-3/4"></div>
                </div>
                <div className="space-y-3">
                  <div className="h-3 bg-primary-100 rounded-lg w-full"></div>
                  <div className="h-3 bg-primary-100 rounded-lg w-5/6"></div>
                  <div className="h-3 bg-primary-100 rounded-lg w-4/6"></div>
                </div>
                <div className="flex items-center space-x-3 mt-6">
                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                  <span className="text-sm text-sage-600">AI-generated SOAP note</span>
                </div>
              </div>
            </div>
          </motion.div>
        );

      case "Time-Saving Automation":
        return (
          <motion.div 
            variants={visualVariants}
            className="flex-1 bg-white/95 backdrop-blur-sm rounded-2xl p-8 border border-sage-100 shadow-xl"
          >
            <div className="space-y-6">
              <div className="flex items-center space-x-3 mb-6">
                <Calendar className="w-5 h-5 text-primary-600" />
                <span className="text-base font-medium text-primary-700">Smart Scheduling</span>
              </div>
              <div className="bg-sage-50 rounded-xl p-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-sage-600">Available Slots</span>
                    <span className="text-sm font-medium text-primary-600">12</span>
                  </div>
                  <div className="h-40 bg-gradient-to-b from-primary-100 to-primary-200 rounded-lg p-4">
                    <div className="grid grid-cols-4 gap-2 h-full">
                      {[...Array(12)].map((_, i) => (
                        <div key={i} className={`rounded-lg ${i % 3 === 0 ? 'bg-primary-300' : 'bg-primary-200'}`}></div>
                  ))}
                </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        );

      case "Enhanced Security & Compliance":
        return (
          <motion.div 
            variants={visualVariants}
            className="flex-1 bg-white/95 backdrop-blur-sm rounded-2xl p-8 border border-sage-100 shadow-xl"
          >
            <div className="space-y-6">
              <div className="flex items-center space-x-3 mb-6">
                <Shield className="w-5 h-5 text-primary-600" />
                <span className="text-base font-medium text-primary-700">Security Dashboard</span>
              </div>
              <div className="bg-sage-50 rounded-xl p-6">
                <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <span className="text-sm text-sage-600">Security Status</span>
                    <span className="text-sm font-medium text-green-600">Protected</span>
                  </div>
                  <div className="h-40 bg-gradient-to-b from-green-100 to-green-200 rounded-lg p-4">
                    <div className="grid grid-cols-2 gap-4 h-full">
                      <div className="bg-white rounded-lg p-3">
                        <div className="text-sm text-sage-600 mb-1">Encryption</div>
                        <div className="text-lg font-bold text-green-600">Secured</div>
                      </div>
                      <div className="bg-white rounded-lg p-3">
                        <div className="text-sm text-sage-600 mb-1">Compliance</div>
                        <div className="text-lg font-bold text-green-600">HIPAA</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        );

      case "Smart Practice Management":
        return (
          <motion.div 
            variants={visualVariants}
            className="flex-1 bg-white/95 backdrop-blur-sm rounded-2xl p-8 border border-sage-100 shadow-xl"
          >
            <div className="space-y-6">
              <div className="flex items-center space-x-3 mb-6">
                <CreditCard className="w-5 h-5 text-primary-600" />
                <span className="text-base font-medium text-primary-700">Practice Analytics</span>
              </div>
              <div className="bg-sage-50 rounded-xl p-6">
                <div className="flex justify-between items-center mb-6">
                  <h4 className="text-base font-medium text-sage-900">Monthly Revenue</h4>
                  <span className="text-green-600 text-base font-medium">↑ 15%</span>
                </div>
                <div className="h-40 bg-gradient-to-r from-primary-100 to-primary-200 rounded-lg"></div>
                <div className="grid grid-cols-2 gap-4 mt-6">
                  <div className="bg-white rounded-lg p-4 shadow-sm">
                    <div className="text-sm text-sage-600 mb-1">Claims Success</div>
                    <div className="text-2xl font-bold text-sage-900">98%</div>
                  </div>
                  <div className="bg-white rounded-lg p-4 shadow-sm">
                    <div className="text-sm text-sage-600 mb-1">Collection Rate</div>
                    <div className="text-2xl font-bold text-sage-900">99.5%</div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        );

      case "AI-Powered Marketing":
        return (
          <motion.div 
            variants={visualVariants}
            className="flex-1 bg-white/95 backdrop-blur-sm rounded-2xl p-8 border border-sage-100 shadow-xl"
          >
            <div className="space-y-6">
              <div className="flex items-center space-x-3 mb-6">
                <Megaphone className="w-5 h-5 text-primary-600" />
                <span className="text-base font-medium text-primary-700">Content Calendar</span>
              </div>
              <div className="bg-sage-50 rounded-xl p-6">
                <div className="space-y-4">
                  <div className="flex items-center space-x-3">
                    <div className="w-2 h-2 bg-primary-500 rounded-full"></div>
                    <div className="h-3 bg-sage-200 rounded-lg w-3/4"></div>
                  </div>
                  <div className="flex items-center space-x-3">
                    <div className="w-2 h-2 bg-primary-500 rounded-full"></div>
                    <div className="h-3 bg-sage-200 rounded-lg w-2/3"></div>
                  </div>
                  <div className="flex items-center space-x-3">
                    <div className="w-2 h-2 bg-primary-500 rounded-full"></div>
                    <div className="h-3 bg-sage-200 rounded-lg w-1/2"></div>
                  </div>
                </div>
                <div className="mt-6 bg-primary-50 rounded-lg p-4 border-l-4 border-primary-500">
                  <div className="flex items-center space-x-3 mb-3">
                    <Sparkles className="w-5 h-5 text-primary-600" />
                    <span className="text-base font-medium text-primary-700">AI-Generated Post</span>
                  </div>
                  <div className="space-y-3">
                    <div className="h-3 bg-primary-200 rounded-lg w-full"></div>
                    <div className="h-3 bg-primary-200 rounded-lg w-3/4"></div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        );

      case "Smart Client Acquisition":
        return (
          <motion.div 
            variants={visualVariants}
            className="flex-1 bg-white/95 backdrop-blur-sm rounded-2xl p-8 border border-sage-100 shadow-xl"
          >
            <div className="space-y-6">
              <div className="flex items-center space-x-3 mb-6">
                <BarChart2 className="w-5 h-5 text-primary-600" />
                <span className="text-base font-medium text-primary-700">Acquisition Funnel</span>
              </div>
              <div className="bg-sage-50 rounded-xl p-6">
                <div className="h-40 bg-gradient-to-t from-primary-100 to-primary-200 rounded-lg flex items-end justify-center pb-4">
                  <div className="w-3/4 h-3/4 bg-primary-500/20 rounded-lg flex items-end justify-center pb-4">
                    <div className="w-2/3 h-2/3 bg-primary-500/40 rounded-lg flex items-end justify-center pb-4">
                      <div className="w-1/2 h-1/2 bg-primary-500/60 rounded-lg flex items-end justify-center pb-4">
                        <div className="w-1/3 h-1/3 bg-primary-500/80 rounded-lg"></div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 mt-6">
                  <div className="bg-white rounded-lg p-4 shadow-sm">
                    <div className="text-sm text-sage-600 mb-1">Leads</div>
                    <div className="text-2xl font-bold text-sage-900">1.2K</div>
                  </div>
                  <div className="bg-white rounded-lg p-4 shadow-sm">
                    <div className="text-sm text-sage-600 mb-1">Conversions</div>
                    <div className="text-2xl font-bold text-sage-900">350</div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        );

      default:
        return null;
    }
  };

  const renderFeature = (feature: Feature, index: number) => {
    const isLeft = feature.visual === 'left';
    const content = (
      <motion.div 
        variants={itemVariants}
        className="flex-1 space-y-6"
      >
        <div className="mb-10">
          <div className="flex items-center space-x-5 mb-3">
            <div className="p-2.5 rounded-2xl bg-white shadow-sm border border-sage-100 transition-all duration-300 hover:shadow-md hover:border-primary-200">
            <feature.icon className="w-7 h-7 text-primary-600" />
            </div>
            <h3 className="text-3xl sm:text-4xl font-bold text-sage-900 leading-tight">
              {feature.title}
            </h3>
          </div>
          <div className="h-1 w-20 bg-gradient-to-r from-primary-500 to-primary-400 rounded-full ml-16"></div>
        </div>
        <p className="text-lg text-sage-700 leading-relaxed">
          {feature.description}
        </p>
        <ul className="space-y-3">
          {feature.benefits.map((benefit, i) => (
            <motion.li 
              key={i}
              variants={itemVariants}
              className="flex items-start space-x-3"
            >
              <CheckCircle className="w-5 h-5 text-primary-500 mt-1 flex-shrink-0" />
              <span className="text-sage-700">{benefit}</span>
            </motion.li>
          ))}
        </ul>
      </motion.div>
    );

    return (
      <motion.div 
        key={index} 
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
        className="grid md:grid-cols-2 gap-16 items-center mb-24"
      >
        {isLeft ? (
          <>
            {content}
            {renderFeatureVisual(feature)}
          </>
        ) : (
          <>
            {renderFeatureVisual(feature)}
            {content}
          </>
        )}
      </motion.div>
    );
  };

  return (
    <div className="synari-marketing">
      {/* Mobile version - hidden on desktop */}
      <div className="lg:hidden">
        <MobileHeadlineFeatures />
      </div>

      {/* Desktop version - hidden on mobile */}
      <div className="hidden lg:block min-h-screen bg-gradient-to-br from-sage-50 to-primary-50">
        <Header />
      
      {/* Hero Section */}
      <div className="relative overflow-hidden pt-16">
        <div className="absolute inset-0 bg-gradient-to-br from-sage-50 to-primary-50 z-0"></div>
        <div className="absolute inset-0 bg-[url('/src/assets/hero-bg.png')] bg-cover bg-center mix-blend-overlay opacity-10 z-0"></div>
        
        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-20 lg:px-20">
          <div className="grid lg:grid-cols-2 gap-12 items-center lg:overflow-visible">
            {/* Left Column - Text Content */}
            <div className="text-center lg:text-left">
              <motion.div 
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.6, ease: [0.21, 0.47, 0.32, 0.98] }}
                className="inline-flex items-center px-4 py-2 rounded-full bg-primary-500/10 border border-primary-500/20 mb-8"
              >
                <Sparkles className="w-5 h-5 text-primary-600 mr-2" />
                <span className="text-primary-600 font-normal">SYNARI-AI</span>
              </motion.div>
              <motion.h1 
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 0.2, ease: [0.21, 0.47, 0.32, 0.98] }}
                className="text-4xl sm:text-6xl font-semibold text-sage-900 mb-6"
              >
                Automate Your Practice with

                <motion.span 
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: 0.5, ease: [0.21, 0.47, 0.32, 0.98] }}
                  className="text-primary-600 block mt-2"
                >
                  AI-Powered Practice Management
                </motion.span>
              </motion.h1>
              <motion.p 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.4, ease: [0.21, 0.47, 0.32, 0.98] }}
                className="text-xl text-sage-700 max-w-2xl mb-8"
              >
                Synari isn't just practice management software—it's your practice on autopilot. 
                From intake to billing, documentation to marketing, our intelligent workflows handle the 
                busywork so you can stay focused on what matters most: your clients.
              </motion.p>
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.6, ease: [0.21, 0.47, 0.32, 0.98] }}
                className="flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-4"
              >
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="w-full sm:w-auto"
                >
                  <Link 
                    to="/demo"
                    className="w-full px-8 py-4 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition-all duration-200 flex items-center justify-center space-x-2"
                  >
                    <span>Get a Demo</span>
                    <ArrowRight className="w-5 h-5" />
                  </Link>
                </motion.div>
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="w-full sm:w-auto"
                >
          <Link
            to="/"
                    className="w-full px-8 py-4 bg-white hover:bg-sage-50 text-sage-700 font-normal rounded-xl transition-all duration-200 border border-sage-200 flex items-center justify-center"
          >
                    Back to Home
          </Link>
                </motion.div>
              </motion.div>
        </div>

            {/* Right Column - Feature Preview - Hidden on mobile */}
            <div className="hidden lg:block w-full max-w-md sm:max-w-lg md:max-w-xl lg:max-w-full mx-auto relative mt-8 lg:mt-0 lg:pr-20 lg:pt-20 lg:pb-20">
              {/* Floating cards only visible on lg+ */}
              <div className="hidden lg:block invisible absolute -top-16 -right-16 bg-white rounded-2xl p-6 border border-sage-100 shadow-xl animate-hero-card-3 z-20">
                <div className="space-y-4">
                  <div className="flex items-center space-x-3">
                    <Activity className="w-5 h-5 text-primary-600" />
                    <span className="text-base font-medium text-primary-700">Session Analytics</span>
                  </div>
                  <div className="bg-sage-50 rounded-xl p-4">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-sage-600">Total Sessions</span>
                        <span className="text-sm font-medium text-primary-600">24</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-sage-600">Avg. Duration</span>
                        <span className="text-sm font-medium text-primary-600">45m</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-sage-600">Completion %</span>
                        <span className="text-sm font-medium text-primary-600">98%</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-2xl p-4 sm:p-6 md:p-8 border border-sage-100 shadow-xl animate-hero-card-1 z-10">
                <div className="space-y-6">
                  <div className="flex items-center space-x-3 mb-6">
                    <Brain className="w-5 h-5 text-primary-600" />
                    <span className="text-base font-medium text-primary-700">AI Session Assistant</span>
                  </div>
                  <div className="bg-sage-50 rounded-xl p-6 space-y-6">
                    {/* Real-time Analysis */}
                    <div className="bg-white rounded-lg p-4 border border-sage-100">
                      <div className="flex items-center space-x-2 mb-3">
                        <Activity className="w-4 h-4 text-primary-500" />
                        <span className="text-sm font-medium text-primary-700">Real-time Analysis</span>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-sage-600">Sentiment Score</span>
                          <span className="text-sm font-medium text-primary-600">Positive</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-sage-600">Engagement Level</span>
                          <span className="text-sm font-medium text-primary-600">High</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-sage-600">Key Topics</span>
                          <span className="text-sm font-medium text-primary-600">Anxiety, Sleep</span>
                        </div>
          </div>
        </div>

                    {/* AI Insights */}
                    <div className="bg-white rounded-lg p-4 border border-sage-100">
                      <div className="flex items-center space-x-2 mb-3">
                        <Sparkles className="w-4 h-4 text-primary-500" />
                        <span className="text-sm font-medium text-primary-700">AI Insights</span>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-start space-x-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-primary-500 mt-1.5"></div>
                          <p className="text-sm text-sage-700">Progress in anxiety management techniques</p>
                        </div>
                        <div className="flex items-start space-x-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-primary-500 mt-1.5"></div>
                          <p className="text-sm text-sage-700">Suggested focus on sleep hygiene</p>
                        </div>
                        <div className="flex items-start space-x-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-primary-500 mt-1.5"></div>
                          <p className="text-sm text-sage-700">Pattern detected in stress triggers</p>
                        </div>
                      </div>
        </div>

                    {/* Treatment Recommendations */}
                    <div className="bg-white rounded-lg p-4 border border-sage-100">
                      <div className="flex items-center space-x-2 mb-3">
                        <Lightbulb className="w-4 h-4 text-primary-500" />
                        <span className="text-sm font-medium text-primary-700">AI Recommendations</span>
                      </div>
                      <div className="space-y-3">
                        <div className="flex items-center space-x-2">
                          <CheckCircle className="w-4 h-4 text-green-500" />
                          <span className="text-sm text-sage-700">CBT Techniques for Anxiety</span>
                        </div>
                        <div className="flex items-center space-x-2">
                          <CheckCircle className="w-4 h-4 text-green-500" />
                          <span className="text-sm text-sage-700">Sleep Hygiene Protocol</span>
                        </div>
                        <div className="flex items-center space-x-2">
                          <CheckCircle className="w-4 h-4 text-green-500" />
                          <span className="text-sm text-sage-700">Mindfulness Exercises</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="hidden lg:block invisible absolute -bottom-14 -right-16 bg-white rounded-2xl p-4 sm:p-8 border border-sage-100 shadow-xl animate-hero-card-2 z-20">
                <div className="space-y-6">
                  <div className="flex items-center space-x-3 mb-6">
                    <MessageSquare className="w-5 h-5 text-primary-600" />
                    <span className="text-base font-medium text-primary-700">AI Session Summary</span>
                  </div>
                  <div className="bg-sage-50 rounded-xl p-6">
                    <div className="space-y-4">
                      <div className="flex items-center space-x-3">
                        <div className="w-2 h-2 bg-primary-500 rounded-full"></div>
                        <div className="h-3 bg-sage-200 rounded-lg w-[95%]"></div>
                      </div>
                      <div className="flex items-center space-x-3">
                        <div className="w-2 h-2 bg-primary-500 rounded-full"></div>
                        <div className="h-3 bg-sage-200 rounded-lg w-[90%]"></div>
                      </div>
                      <div className="flex items-center space-x-3">
                        <div className="w-2 h-2 bg-primary-500 rounded-full"></div>
                        <div className="h-3 bg-sage-200 rounded-lg w-[85%]"></div>
                      </div>
                    </div>
                    <div className="mt-6 bg-primary-50 rounded-lg p-4 border-l-4 border-primary-500">
                      <div className="flex items-center space-x-3 mb-3">
                        <Sparkles className="w-5 h-5 text-primary-600" />
                        <span className="text-base font-medium text-primary-700">AI Analysis</span>
                      </div>
                      <div className="space-y-3">
                        <div className="h-3 bg-primary-100 rounded-lg w-full"></div>
                        <div className="h-3 bg-primary-100 rounded-lg w-[95%]"></div>
                        <div className="h-3 bg-primary-100 rounded-lg w-[90%]"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Features Section */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center px-4 py-2 rounded-full bg-primary-500/10 border border-primary-500/20 mb-6">
            <Sparkles className="w-5 h-5 text-primary-600 mr-2" />
            <span className="text-primary-600 font-normal">FEATURES</span>
          </div>
          <h2 className="text-4xl sm:text-5xl font-semibold text-sage-900 mb-6 bg-clip-text text-transparent bg-gradient-to-r from-sage-900 to-primary-600">
            Powerful Features for Modern Practices
          </h2>
          <p className="text-xl text-sage-700 max-w-3xl mx-auto leading-relaxed">
            Discover how our AI-powered platform can transform your practice management and client care.
          </p>
          <div className="mt-8 flex justify-center">
            <div className="h-1 w-20 bg-gradient-to-r from-primary-500 to-primary-600 rounded-full"></div>
          </div>
        </motion.div>

        {/* Mobile Feature Cards - Only visible on mobile */}
        <div className="lg:hidden space-y-6 mb-16">
          {features.map((feature, index) => {
            const getColorClasses = (color: string | undefined) => {
              switch (color) {
                case 'purple':
                  return {
                    bg: 'bg-gradient-to-br from-purple-500 to-purple-600',
                    border: 'border-purple-300',
                    shadow: 'shadow-purple-100',
                    icon: 'bg-purple-100 text-purple-600',
                    badge: 'bg-purple-50 text-purple-700 border-purple-200'
                  };
                case 'blue':
                  return {
                    bg: 'bg-gradient-to-br from-blue-500 to-blue-600',
                    border: 'border-blue-300',
                    shadow: 'shadow-blue-100',
                    icon: 'bg-blue-100 text-blue-600',
                    badge: 'bg-blue-50 text-blue-700 border-blue-200'
                  };
                case 'green':
                  return {
                    bg: 'bg-gradient-to-br from-green-500 to-green-600',
                    border: 'border-green-300',
                    shadow: 'shadow-green-100',
                    icon: 'bg-green-100 text-green-600',
                    badge: 'bg-green-50 text-green-700 border-green-200'
                  };
                case 'orange':
                  return {
                    bg: 'bg-gradient-to-br from-orange-500 to-orange-600',
                    border: 'border-orange-300',
                    shadow: 'shadow-orange-100',
                    icon: 'bg-orange-100 text-orange-600',
                    badge: 'bg-orange-50 text-orange-700 border-orange-200'
                  };
                default:
                  return {
                    bg: 'bg-gradient-to-br from-primary-500 to-primary-600',
                    border: 'border-primary-300',
                    shadow: 'shadow-primary-100',
                    icon: 'bg-primary-100 text-primary-600',
                    badge: 'bg-primary-50 text-primary-700 border-primary-200'
                  };
              }
            };

            const colors = getColorClasses(feature.color);

            return (
              <motion.div
                key={`mobile-main-${index}`}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1, duration: 0.5 }}
                className={`relative overflow-hidden rounded-2xl ${colors.bg} text-white shadow-xl`}
              >
                {/* Background Pattern */}
                <div className="absolute top-0 right-0 w-32 h-32 opacity-10">
                  <div className="absolute top-4 right-4 w-8 h-8 bg-white rounded-full"></div>
                  <div className="absolute top-8 right-8 w-4 h-4 bg-white rounded-full"></div>
                  <div className="absolute top-12 right-12 w-2 h-2 bg-white rounded-full"></div>
                </div>

                <div className="relative p-6">
                  {/* Icon and Title */}
                  <div className="flex items-start space-x-4 mb-4">
                    <div className={`p-3 rounded-xl ${colors.icon} shadow-lg`}>
                      <feature.icon className="w-6 h-6" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-xl font-semibold mb-2">{feature.title}</h3>
                      <p className="text-white/90 text-sm leading-relaxed">
                        {feature.description}
                      </p>
                    </div>
                  </div>

                  {/* Benefits */}
                  <div className="space-y-2">
                    {feature.benefits.slice(0, 3).map((benefit, benefitIndex) => (
                      <div key={benefitIndex} className="flex items-center space-x-3">
                        <CheckCircle className="w-4 h-4 text-white/80 flex-shrink-0" />
                        <span className="text-sm text-white/90">{benefit}</span>
                      </div>
                    ))}
                  </div>

                  {/* CTA */}
                  <div className="mt-4 pt-4 border-t border-white/20">
                    <button className="flex items-center space-x-2 text-white/90 hover:text-white transition-colors">
                      <span className="text-sm font-normal">Learn More</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Desktop Feature Display - Hidden on mobile */}
        <div className="hidden lg:block space-y-16">
          {features.map((feature, index) => renderFeature(feature, index))}
        </div>

        {/* Marketing Features Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="mt-20 text-center mb-16"
        >
          <div className="inline-flex items-center px-4 py-2 rounded-full bg-primary-500/10 border border-primary-500/20 mb-6">
            <Megaphone className="w-5 h-5 text-primary-600 mr-2" />
            <span className="text-primary-600 font-normal">GROWTH</span>
          </div>
          <h2 className="text-4xl sm:text-5xl font-semibold text-sage-900 mb-6 bg-clip-text text-transparent bg-gradient-to-r from-sage-900 to-primary-600">
            Grow Your Practice with AI
          </h2>
          <p className="text-xl text-sage-700 max-w-3xl mx-auto leading-relaxed">
            Let our AI-powered marketing tools help you attract and retain your ideal clients.
          </p>
          <div className="mt-8 flex justify-center">
            <div className="h-1 w-20 bg-gradient-to-r from-primary-500 to-primary-600 rounded-full"></div>
          </div>
        </motion.div>

        {/* Mobile Marketing Feature Cards - Only visible on mobile */}
        <div className="lg:hidden space-y-6 mb-16">
          {marketingFeatures.map((feature, index) => {
            const getColorClasses = (color: string | undefined) => {
              switch (color) {
                case 'pink':
                  return {
                    bg: 'bg-gradient-to-br from-pink-500 to-pink-600',
                    border: 'border-pink-300',
                    shadow: 'shadow-pink-100',
                    icon: 'bg-pink-100 text-pink-600',
                    badge: 'bg-pink-50 text-pink-700 border-pink-200'
                  };
                case 'teal':
                  return {
                    bg: 'bg-gradient-to-br from-teal-500 to-teal-600',
                    border: 'border-teal-300',
                    shadow: 'shadow-teal-100',
                    icon: 'bg-teal-100 text-teal-600',
                    badge: 'bg-teal-50 text-teal-700 border-teal-200'
                  };
                default:
                  return {
                    bg: 'bg-gradient-to-br from-primary-500 to-primary-600',
                    border: 'border-primary-300',
                    shadow: 'shadow-primary-100',
                    icon: 'bg-primary-100 text-primary-600',
                    badge: 'bg-primary-50 text-primary-700 border-primary-200'
                  };
              }
            };

            const colors = getColorClasses(feature.color);

            return (
              <motion.div
                key={`mobile-marketing-${index}`}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1, duration: 0.5 }}
                className={`relative overflow-hidden rounded-2xl ${colors.bg} text-white shadow-xl`}
              >
                {/* Background Pattern */}
                <div className="absolute top-0 right-0 w-32 h-32 opacity-10">
                  <div className="absolute top-4 right-4 w-8 h-8 bg-white rounded-full"></div>
                  <div className="absolute top-8 right-8 w-4 h-4 bg-white rounded-full"></div>
                  <div className="absolute top-12 right-12 w-2 h-2 bg-white rounded-full"></div>
                </div>

                <div className="relative p-6">
                  {/* Icon and Title */}
                  <div className="flex items-start space-x-4 mb-4">
                    <div className={`p-3 rounded-xl ${colors.icon} shadow-lg`}>
                      <feature.icon className="w-6 h-6" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-xl font-semibold mb-2">{feature.title}</h3>
                      <p className="text-white/90 text-sm leading-relaxed">
                        {feature.description}
                      </p>
                    </div>
                  </div>

                  {/* Benefits */}
                  <div className="space-y-2">
                    {feature.benefits.slice(0, 3).map((benefit, benefitIndex) => (
                      <div key={benefitIndex} className="flex items-center space-x-3">
                        <CheckCircle className="w-4 h-4 text-white/80 flex-shrink-0" />
                        <span className="text-sm text-white/90">{benefit}</span>
                      </div>
                    ))}
                  </div>

                  {/* CTA */}
                  <div className="mt-4 pt-4 border-t border-white/20">
                    <button className="flex items-center space-x-2 text-white/90 hover:text-white transition-colors">
                      <span className="text-sm font-normal">Learn More</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Desktop Marketing Features Display - Hidden on mobile */}
        <div className="hidden lg:block space-y-24">
          {marketingFeatures.map((feature, index) => renderFeature(feature, index))}
        </div>

        {/* Get a Demo Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="mt-20 text-center"
        >
          <div className="relative overflow-hidden bg-gradient-to-br from-primary-500 via-primary-600 to-primary-700 rounded-2xl lg:rounded-3xl p-6 lg:p-10 text-white shadow-2xl">
            {/* Background decorative elements - Smaller on mobile */}
            <div className="absolute top-0 left-0 w-32 h-32 lg:w-72 lg:h-72 bg-white/5 rounded-full -translate-x-16 -translate-y-16 lg:-translate-x-36 lg:-translate-y-36"></div>
            <div className="absolute bottom-0 right-0 w-48 h-48 lg:w-96 lg:h-96 bg-white/5 rounded-full translate-x-24 translate-y-24 lg:translate-x-48 lg:translate-y-48"></div>
            <div className="absolute top-1/2 left-1/2 w-32 h-32 lg:w-64 lg:h-64 bg-white/3 rounded-full -translate-x-16 -translate-y-16 lg:-translate-x-32 lg:-translate-y-32"></div>
            
            <div className="relative z-10 max-w-4xl mx-auto">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="inline-flex items-center px-3 py-2 lg:px-6 lg:py-3 rounded-full bg-white/15 backdrop-blur-sm border border-white/25 mb-6 lg:mb-10 shadow-lg"
              >
                <Sparkles className="w-4 h-4 lg:w-5 lg:h-5 text-white mr-2 lg:mr-3 animate-pulse" />
                <span className="text-white font-normal tracking-wide text-sm lg:text-base">READY TO TRANSFORM YOUR PRACTICE?</span>
              </motion.div>
              
              <motion.h2 
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: 0.3 }}
                className="text-3xl sm:text-4xl lg:text-5xl xl:text-6xl font-semibold text-white mb-4 lg:mb-8 leading-tight"
              >
                See <span className="bg-gradient-to-r from-teal-300 to-cyan-300 bg-clip-text text-transparent pb-1">Synari</span> in Action
              </motion.h2>
              
              <motion.p 
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: 0.4 }}
                className="text-base sm:text-lg lg:text-xl xl:text-2xl text-primary-100 mb-8 lg:mb-12 max-w-3xl mx-auto leading-relaxed font-normal"
              >
                Schedule a personalized demo to see how Synari can streamline your practice management, 
                automate your workflows, and help you focus on what matters most—your clients.
              </motion.p>
              
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: 0.5 }}
                className="flex flex-col sm:flex-row items-center justify-center gap-4 lg:gap-6 mb-8 lg:mb-12"
              >
                <motion.div
                  whileHover={{ scale: 1.05, y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  className="group w-full sm:w-auto"
                >
                  <Link 
                    to="/demo"
                    className="inline-flex items-center justify-center space-x-2 lg:space-x-3 bg-white text-primary-600 px-6 py-3 lg:px-10 lg:py-5 rounded-xl lg:rounded-2xl hover:bg-primary-50 transition-all duration-300 transform hover:scale-105 font-bold text-base lg:text-lg shadow-xl hover:shadow-2xl border-2 border-white w-full sm:w-auto"
                  >
                    <span>Get a Demo</span>
                    <ArrowRight className="w-5 h-5 lg:w-6 lg:h-6 group-hover:translate-x-1 transition-transform duration-300" />
                  </Link>
                </motion.div>
                
                <motion.div
                  whileHover={{ scale: 1.05, y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  className="w-full sm:w-auto"
                >
                  <Link 
                    to="/"
                    className="inline-flex items-center justify-center space-x-2 lg:space-x-3 bg-white/10 backdrop-blur-sm text-white px-6 py-3 lg:px-10 lg:py-5 rounded-xl lg:rounded-2xl hover:bg-white/20 transition-all duration-300 border-2 border-white/30 font-normal text-base lg:text-lg hover:border-white/50 w-full sm:w-auto"
                  >
                    <span>Back to Home</span>
                  </Link>
                </motion.div>
              </motion.div>
              
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: 0.6 }}
                className="flex flex-col sm:flex-row items-center justify-center space-y-2 sm:space-y-0 sm:space-x-8 lg:space-x-12 text-primary-100 text-sm lg:text-base font-normal"
              >
                <div className="flex items-center space-x-2 lg:space-x-3">
                  <div className="w-2 h-2 lg:w-3 lg:h-3 bg-primary-200 rounded-full animate-pulse"></div>
                  <span>Personalized demo</span>
                </div>
                <div className="flex items-center space-x-2 lg:space-x-3">
                  <div className="w-2 h-2 lg:w-3 lg:h-3 bg-primary-200 rounded-full animate-pulse" style={{ animationDelay: '0.5s' }}></div>
                  <span>No commitment required</span>
                </div>
                <div className="flex items-center space-x-2 lg:space-x-3">
                  <div className="w-2 h-2 lg:w-3 lg:h-3 bg-primary-200 rounded-full animate-pulse" style={{ animationDelay: '1s' }}></div>
                  <span>30-minute session</span>
                </div>
              </motion.div>
            </div>
          </div>
        </motion.div>
      </div>
      </div>
    </div>
  );
};

export default HeadlineFeatures; 
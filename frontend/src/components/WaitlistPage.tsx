import React, { useState, useEffect } from 'react';
import { Bell, Mail, Building, ArrowRight, CheckCircle, Users, Play } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Link } from 'react-router-dom';
import Header from './Header';
import { motion } from 'framer-motion';
import { useAnalytics } from '../lib/analytics';
import './brand-mark.css';

const WaitlistPage = () => {
  const { trackWaitlistJoin, trackDemoRequest } = useAnalytics();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const [formData, setFormData] = useState({
    email: '',
    firstName: '',
    lastName: '',
    practiceName: '',
    practiceType: '',
    practiceSize: '',
    currentEHR: '',
    biggestChallenge: '',
    interests: [] as string[]
  });

  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const practiceTypes = [
    'Solo Practice',
    'Group Practice',
    'Community Mental Health',
    'Hospital/Health System',
    'University Counseling Center',
    'Other'
  ];

  const practiceSizes = [
    'Just me',
    '2-5 therapists',
    '6-15 therapists',
    '16-50 therapists',
    '50+ therapists'
  ];

  const currentEHRs = [
    'SimplePractice',
    'TherapyNotes',
    'TheraNest',
    'Therabill',
    'Paper-based',
    'Other',
    'None currently'
  ];

  const interestOptions = [
    'AI-powered documentation',
    'Automated scheduling',
    'Insurance billing automation',
    'Practice analytics',
    'Telehealth integration',
    'Mobile app',
    'Group therapy features',
    'Specialty forms (CBT, DBT, etc.)'
  ];

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleInterestChange = (interest: string) => {
    setFormData(prev => ({
      ...prev,
      interests: prev.interests.includes(interest)
        ? prev.interests.filter(i => i !== interest)
        : [...prev.interests, interest]
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      if (!supabase) {
        throw new Error("The waitlist isn't set up on this server.");
      }
      const { error } = await supabase.from('waitlist').insert({
        email: formData.email,
        first_name: formData.firstName,
        last_name: formData.lastName,
        practice_name: formData.practiceName,
        practice_type: formData.practiceType,
        practice_size: formData.practiceSize,
        current_ehr: formData.currentEHR,
        biggest_challenge: formData.biggestChallenge,
        interests: formData.interests,
        created_at: new Date().toISOString(),
      });
      if (error) {
        throw new Error("We couldn't save your request. Please try again.");
      }

      // Track successful waitlist/demo signup
      trackWaitlistJoin('demo_form');
      trackDemoRequest({
        practice_type: formData.practiceType,
        practice_size: formData.practiceSize,
      });

      setIsSubmitted(true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      setSubmitError(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSubmitted) {
    return (
      <div className="synari-marketing min-h-screen bg-gradient-to-br from-sage-50 to-primary-50">
        <Header />
        <div className="flex items-center justify-center px-4 pt-16 min-h-screen">
          <div className="max-w-md mx-auto text-center">
          <div className="bg-white rounded-2xl p-8 shadow-xl border border-sage-100">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle className="w-8 h-8 text-green-600" />
            </div>
            <h2 className="text-2xl font-semibold text-sage-900 mb-4">
              Demo Request Received!
            </h2>
            <p className="text-sage-700 mb-6">
              Thank you for your interest in Synari. We'll review your information and contact you within 24 hours to schedule your personalized demo.
            </p>
            <button 
              onClick={() => setIsSubmitted(false)}
              className="text-primary-600 hover:text-primary-700 font-normal"
            >
              ← Back to form
            </button>
          </div>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="synari-marketing min-h-screen bg-gradient-to-br from-sage-50 to-primary-50">
      <Header />

      {/* Hero Section */}
      <div className="relative overflow-hidden pt-16">
        <div className="absolute inset-0 bg-gradient-to-br from-sage-50 to-primary-50 z-0"></div>
        <div className="absolute inset-0 bg-[url('/src/assets/hero-bg.png')] bg-cover bg-center mix-blend-overlay opacity-10 z-0"></div>
        
        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-20">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            {/* Left Column - Text Content */}
            <div className="text-center lg:text-left">
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: [0.21, 0.47, 0.32, 0.98] }}
                className="inline-flex items-center px-4 py-2 rounded-full bg-primary-500/10 border border-primary-500/20 mb-8"
              >
                <Bell className="w-5 h-5 text-primary-600 mr-2" />
                <span className="text-primary-600 font-normal">SCHEDULE DEMO</span>
              </motion.div>
              <motion.h1 
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 0.2, ease: [0.21, 0.47, 0.32, 0.98] }}
                className="text-4xl sm:text-6xl font-semibold text-sage-900 mb-6"
              >
                See How Synari Can
                <motion.span 
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: 0.5, ease: [0.21, 0.47, 0.32, 0.98] }}
                  className="text-primary-600 block mt-2"
                >
                  Transform Your Practice
                </motion.span>
              </motion.h1>
              <motion.p 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.4, ease: [0.21, 0.47, 0.32, 0.98] }}
                className="text-xl text-sage-700 max-w-2xl mb-8"
              >
                Schedule a personalized demo to see Synari's AI-powered features in action 
                and discover how it can streamline your practice management.
              </motion.p>
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.6, ease: [0.21, 0.47, 0.32, 0.98] }}
                className="flex flex-col sm:flex-row items-center justify-center lg:justify-start space-y-3 sm:space-y-0 sm:space-x-4 mb-8"
              >
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Link
                    to="/features"
                    className="w-full sm:w-auto bg-white text-primary-600 px-6 sm:px-8 py-3 sm:py-4 rounded-lg hover:bg-sage-50 transition-colors duration-300 transform hover:scale-105 text-base sm:text-lg font-semibold shadow-xl border border-primary-200 flex items-center justify-center space-x-2"
                  >
                    <span>Learn More</span>
                    <Play className="w-5 h-5" />
                  </Link>
                </motion.div>
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Link
                    to="/"
                    className="w-full sm:w-auto bg-primary-500 text-white px-6 sm:px-8 py-3 sm:py-4 rounded-lg hover:bg-primary-600 transition-colors duration-300 transform hover:scale-105 text-base sm:text-lg font-semibold shadow-xl flex items-center justify-center space-x-2"
                  >
                    <span>Back to Home</span>
                    <ArrowRight className="w-5 h-5" />
                  </Link>
                </motion.div>
              </motion.div>
            </div>

            {/* Right Column - Waitlist Preview - Hidden on mobile */}
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.3, ease: [0.21, 0.47, 0.32, 0.98] }}
              className="hidden lg:block relative"
            >
              <div className="bg-white rounded-2xl p-8 border border-sage-100 shadow-xl">
                <div className="space-y-6">
                  <div className="flex items-center space-x-3 mb-6">
                    <Users className="w-5 h-5 text-primary-600" />
                    <span className="text-base font-normal text-primary-700">Schedule Your Demo</span>
          </div>
                  <div className="bg-sage-50 rounded-xl p-6">
                    <div className="space-y-4">
                      {/* Email Header */}
                      <div className="flex items-center space-x-3 border-b border-sage-200 pb-3">
                        <Mail className="w-5 h-5 text-sage-600" />
                        <div className="h-4 bg-sage-200 rounded-lg w-3/4"></div>
        </div>
                      
                      {/* Welcome Message */}
                      <div className="space-y-3">
                        <div className="h-3 bg-primary-100 rounded-lg w-0 animate-typing-animation" style={{ animationDelay: '0.3s' }}></div>
                        <div className="h-3 bg-primary-100 rounded-lg w-0 animate-typing-animation" style={{ animationDelay: '0.6s' }}></div>
                        <div className="h-3 bg-primary-100 rounded-lg w-0 animate-typing-animation" style={{ animationDelay: '0.9s' }}></div>
                        <div className="h-3 bg-primary-100 rounded-lg w-0 animate-typing-animation" style={{ animationDelay: '1.2s' }}></div>
          </div>

                      {/* Status */}
                      <div className="flex items-center space-x-3 mt-6 pt-4 border-t border-sage-200">
                        <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                        <span className="text-sm text-sage-600">Early access granted</span>
                      </div>
                    </div>
            </div>
            </div>
              </div>
            </motion.div>
          </div>
            </div>
          </div>

      {/* Form Section */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
          <div className="bg-white rounded-2xl shadow-xl border border-sage-100 p-8">
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Personal Information */}
              <div>
                <h3 className="text-lg font-semibold text-sage-900 mb-4">Personal Information</h3>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="firstName" className="block text-sm font-normal text-sage-700 mb-2">
                      First Name *
                    </label>
                    <input
                      type="text"
                      id="firstName"
                      name="firstName"
                      required
                      value={formData.firstName}
                      onChange={handleInputChange}
                      className="w-full px-4 py-3 rounded-lg border border-sage-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 focus:outline-none"
                    />
                  </div>
                  <div>
                                          <label htmlFor="lastName" className="block text-sm font-normal text-sage-700 mb-2">
                      Last Name *
                    </label>
                    <input
                      type="text"
                      id="lastName"
                      name="lastName"
                      required
                      value={formData.lastName}
                      onChange={handleInputChange}
                      className="w-full px-4 py-3 rounded-lg border border-sage-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label htmlFor="email" className="block text-sm font-normal text-sage-700 mb-2">
                    Email Address *
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-sage-400" />
                    <input
                      type="email"
                      id="email"
                      name="email"
                      required
                      value={formData.email}
                      onChange={handleInputChange}
                      className="w-full pl-10 pr-4 py-3 rounded-lg border border-sage-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 focus:outline-none"
                      placeholder="your.email@example.com"
                    />
                  </div>
                </div>
              </div>

              {/* Practice Information */}
              <div>
                <h3 className="text-lg font-semibold text-sage-900 mb-4">Practice Information</h3>
                <div className="space-y-4">
                  <div>
                    <label htmlFor="practiceName" className="block text-sm font-normal text-sage-700 mb-2">
                      Practice Name *
                    </label>
                    <div className="relative">
                      <Building className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-sage-400" />
                      <input
                        type="text"
                        id="practiceName"
                        name="practiceName"
                        required
                        value={formData.practiceName}
                        onChange={handleInputChange}
                        className="w-full pl-10 pr-4 py-3 rounded-lg border border-sage-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 focus:outline-none"
                        placeholder="Your Practice Name"
                      />
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="practiceType" className="block text-sm font-normal text-sage-700 mb-2">
                        Practice Type *
                      </label>
                      <select
                        id="practiceType"
                        name="practiceType"
                        required
                        value={formData.practiceType}
                        onChange={handleInputChange}
                        className="w-full px-4 py-3 rounded-lg border border-sage-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 focus:outline-none"
                      >
                        <option value="">Select practice type</option>
                        {practiceTypes.map(type => (
                          <option key={type} value={type}>{type}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                                              <label htmlFor="practiceSize" className="block text-sm font-normal text-sage-700 mb-2">
                        Practice Size *
                      </label>
                      <select
                        id="practiceSize"
                        name="practiceSize"
                        required
                        value={formData.practiceSize}
                        onChange={handleInputChange}
                        className="w-full px-4 py-3 rounded-lg border border-sage-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 focus:outline-none"
                      >
                        <option value="">Select practice size</option>
                        {practiceSizes.map(size => (
                          <option key={size} value={size}>{size}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="currentEHR" className="block text-sm font-normal text-sage-700 mb-2">
                      Current EHR System
                    </label>
                    <select
                      id="currentEHR"
                      name="currentEHR"
                      value={formData.currentEHR}
                      onChange={handleInputChange}
                      className="w-full px-4 py-3 rounded-lg border border-sage-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 focus:outline-none"
                    >
                      <option value="">Select current EHR</option>
                      {currentEHRs.map(ehr => (
                        <option key={ehr} value={ehr}>{ehr}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Interests */}
              <div>
                <h3 className="text-lg font-semibold text-sage-900 mb-4">What interests you most about Synari?</h3>
                <div className="grid md:grid-cols-2 gap-3">
                  {interestOptions.map(interest => (
                    <label key={interest} className="flex items-center space-x-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.interests.includes(interest)}
                        onChange={() => handleInterestChange(interest)}
                        className="w-4 h-4 text-primary-600 border-sage-300 rounded focus:ring-primary-500"
                      />
                      <span className="text-sage-700">{interest}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Biggest Challenge */}
              <div>
                <label htmlFor="biggestChallenge" className="block text-sm font-normal text-sage-700 mb-2">
                  What's your biggest challenge with practice management today?
                </label>
                <textarea
                  id="biggestChallenge"
                  name="biggestChallenge"
                  rows={4}
                  value={formData.biggestChallenge}
                  onChange={handleInputChange}
                  className="w-full px-4 py-3 rounded-lg border border-sage-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 focus:outline-none"
                  placeholder="Tell us about your current pain points..."
                />
              </div>

              {/* Error Display */}
              {submitError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-red-800">
                        Submission Error
                      </h3>
                      <div className="mt-2 text-sm text-red-700">
                        <p>{submitError}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Submit Button */}
              <div className="pt-6">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className={`w-full px-8 py-4 rounded-lg transition-all duration-200 flex items-center justify-center space-x-2 text-lg font-semibold ${
                    isSubmitting 
                      ? 'bg-sage-400 text-white cursor-not-allowed' 
                      : 'bg-primary-500 text-white hover:bg-primary-600 transform hover:scale-105'
                  }`}
                >
                  {isSubmitting ? (
                    <>
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                      <span>Submitting...</span>
                    </>
                  ) : (
                    <>
                      <Bell className="w-5 h-5" />
                      <span>Schedule Demo</span>
                      <ArrowRight className="w-5 h-5" />
                    </>
                  )}
                </button>
                <p className="text-sage-600 text-sm text-center mt-3">
                  We respect your privacy. No spam, unsubscribe anytime.
                </p>
              </div>
            </form>
          </div>
        </div>
      <div id="demo-form"></div>
    </div>
  );
};

export default WaitlistPage;
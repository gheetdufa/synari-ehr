import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { FaLinkedin, FaGlobe } from 'react-icons/fa';
import { Heart, Lightbulb, Rocket, Users, Target, Award, ArrowLeft, Zap, Brain, Star, MessageCircle, Building, Sparkles, Clock } from 'lucide-react';
import Header from './Header';

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: 0.1 + i * 0.1, duration: 0.5 } })
};

const roadmapSteps = [
  {
    icon: Users,
    title: 'College Roommates',
    date: '2023',
    description: 'Met at UMD, became coding partners',
    status: 'completed'
  },
  {
    icon: Lightbulb,
    title: 'Multiple Projects',
    date: '2023–2024',
    description: 'Built various apps, gained experience',
    status: 'completed'
  },
  {
    icon: MessageCircle,
    title: 'Therapist Interviews',
    date: 'Jun 2025',
    description: 'Conducted in-depth research with therapists',
    status: 'completed'
  },
  {
    icon: Brain,
    title: 'The Realization',
    date: 'Jul 2025',
    description: 'Discovered the admin burden problem',
    status: 'completed'
  },
  {
    icon: Rocket,
    title: 'The Leap',
    date: 'Aug 2025',
    description: 'Dropped everything to build Synari',
    status: 'completed'
  },
  {
    icon: Building,
    title: 'MVP Development',
    date: 'Present',
    description: 'MVP nearly finished—seeking funding & pilot partners',
    status: 'current'
  },
  {
    icon: Sparkles,
    title: 'Beta Launch',
    date: 'Q1 2026',
    description: 'First therapists testing the platform',
    status: 'upcoming'
  },
  {
    icon: Target,
    title: 'Full Launch',
    date: 'Q2 2026',
    description: 'Revolutionizing therapy practice management',
    status: 'upcoming'
  }
];

const founders = [
  {
    name: 'Dheer Guda',
    title: 'Co-Founder & CEO',
    location: 'College Park, MD',
    socials: [
      { icon: FaLinkedin, url: 'https://www.linkedin.com/in/dheer-guda/', label: 'LinkedIn' },
      { icon: FaGlobe, url: 'https://dheerguda.com', label: 'Portfolio' },
    ],
    skills: ['Full-Stack', 'Product Strategy', 'UI/UX', 'React', 'Node.js'],
    description: 'Serial entrepreneur who dropped everything to pursue this vision. Has launched multiple successful projects and believes that great products come from truly understanding user pain points.',
    achievements: ['5+ Successful Launches', 'Product Design Expert', 'User Experience Specialist'],
    quote: "Every line of code we write is motivated by the therapists who'll get to leave work earlier and feel less stressed."
  },
  {
    name: 'Ateef Mahmud',
    title: 'Co-Founder & CTO',
    location: 'College Park, MD',
    socials: [
      { icon: FaLinkedin, url: 'https://www.linkedin.com/in/ateefmahmud', label: 'LinkedIn' },
    ],
    skills: ['AI/ML', 'Python', 'PyTorch', 'Azure', 'Backend Systems'],
    description: 'Machine Learning Engineer who left his secure tech career to build AI that actually helps people. Specializes in enterprise-scale AI implementations and has a passion for solving complex problems.',
    achievements: ['ML Research at UMD', 'Azure Certified', '5+ AI/ML Projects'],
    quote: "We're not just building software—we're giving therapists their time back so they can focus on healing."
  }
];

const FoundersSection = ({ showHeader = true }: { showHeader?: boolean }) => {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-sage-50 via-white to-primary-50">
      {/* Header */}
      {showHeader && <Header />}

      {/* Hero Section */}
      <section className="relative py-12 px-4 overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-20 -left-20 w-72 h-72 bg-primary-100 rounded-full opacity-20 blur-3xl animate-pulse" />
          <div className="absolute -bottom-20 -right-20 w-72 h-72 bg-sage-200 rounded-full opacity-20 blur-3xl animate-pulse animation-delay-2000" />
        </div>
        
        <div className="relative max-w-6xl mx-auto text-center z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="mb-12"
          >
            <div className="inline-flex items-center px-4 py-2 rounded-full bg-primary-100 text-primary-700 mb-6">
              <Star className="w-4 h-4 mr-2" />
              <span className="font-normal">OUR JOURNEY</span>
            </div>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-semibold text-sage-900 mb-6">
              We Dropped Everything to 
              <span className="block bg-gradient-to-r from-primary-600 to-primary-500 bg-clip-text text-transparent mt-2">Build This</span>
            </h1>
            <p className="text-xl text-sage-700 max-w-3xl mx-auto leading-relaxed">
              Two engineers who saw how much time therapists waste on admin work—and decided to fix it.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Roadmap Section */}
      <section className="py-16 px-4">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl sm:text-4xl font-semibold text-sage-900 mb-4">
              Our Roadmap
            </h2>
            <p className="text-lg text-sage-600 mb-6">From college roommates to revolutionizing therapy</p>
            <div className="h-1 w-20 bg-gradient-to-r from-primary-500 to-primary-600 rounded-full mx-auto"></div>
          </motion.div>

          {/* Desktop Roadmap */}
          <div className="hidden lg:block relative">
            {/* Animated connecting line */}
            <svg className="absolute top-20 left-0 w-full h-32 pointer-events-none z-0">
              <defs>
                <linearGradient id="lineGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#10B981" />
                  <stop offset="62.5%" stopColor="#059669" />
                  <stop offset="62.5%" stopColor="#D1D5DB" />
                  <stop offset="100%" stopColor="#D1D5DB" />
                </linearGradient>
              </defs>
              
              <motion.path
                d="M 60 60 Q 140 20 220 60 T 380 60 T 540 60 T 700 60 T 860 60 T 1020 60 T 1180 60"
                stroke="url(#lineGradient)"
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
                initial={{ pathLength: 0 }}
                whileInView={{ pathLength: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 3, delay: 0.5, ease: "easeInOut" }}
              />
            </svg>

            {/* Roadmap Steps */}
            <div className="grid grid-cols-8 gap-4 relative z-10" style={{ paddingTop: '20px' }}>
              {roadmapSteps.map((step, i) => (
                <motion.div
                  key={step.title}
                  initial={{ opacity: 0, y: 30, scale: 0.8 }}
                  whileInView={{ opacity: 1, y: 0, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.2 + i * 0.15, duration: 0.6, ease: "easeOut" }}
                  className="relative"
                >
                  {/* Step Box */}
                  <div className={`bg-white rounded-xl p-4 shadow-lg border-2 transition-all duration-300 hover:shadow-xl h-[280px] flex flex-col ${
                    step.status === 'completed' 
                      ? 'border-primary-300 shadow-primary-100' 
                      : step.status === 'current'
                      ? 'border-primary-500 shadow-primary-200 ring-2 ring-primary-200'
                      : 'border-sage-200 shadow-sage-100'
                  }`}>
                    {/* Icon */}
                    <div className={`relative w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 transition-all duration-300 ${
                      step.status === 'completed' 
                        ? 'bg-primary-500 text-white' 
                        : step.status === 'current'
                        ? 'bg-primary-600 text-white animate-pulse'
                        : 'bg-sage-100 text-sage-400'
                    }`}>
                      <step.icon className="w-6 h-6" />
                      
                      {/* Current step indicator */}
                      {step.status === 'current' && (
                        <motion.div
                          initial={{ scale: 0, opacity: 0 }}
                          whileInView={{ scale: 1, opacity: 1 }}
                          viewport={{ once: true }}
                          transition={{ delay: 3.5, duration: 0.5 }}
                          className="absolute -top-1 -right-1 w-4 h-4 bg-yellow-400 rounded-full flex items-center justify-center"
                        >
                          <Clock className="w-2 h-2 text-yellow-800" />
                        </motion.div>
                      )}
                    </div>
                    
                    {/* Content */}
                    <div className="text-center flex-1 flex flex-col justify-between">
                      <div className="space-y-2 flex-1 flex flex-col justify-center">
                        <h3 className={`font-semibold text-sm leading-tight ${
                          step.status === 'current' ? 'text-primary-700' : 'text-sage-900'
                        }`}>
                          {step.title}
                        </h3>
                        <p className="text-xs text-primary-600 font-normal bg-primary-50 rounded-full px-2 py-1">
                          {step.date}
                        </p>
                        <p className="text-xs text-sage-600 leading-tight flex-1 flex items-center justify-center">
                          {step.description}
                        </p>
                      </div>
                      
                      <div className="mt-3 min-h-[32px] flex items-center justify-center">
                        {/* Status Badge */}
                        {step.status === 'current' && (
                          <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: 4, duration: 0.5 }}
                            className="inline-block px-2 py-1 bg-yellow-100 text-yellow-700 rounded-full text-xs font-normal border border-yellow-200"
                          >
                            ← You are here
                          </motion.div>
                        )}
                        
                        {step.status === 'completed' && (
                          <div className="inline-block px-2 py-1 bg-primary-100 text-primary-700 rounded-full text-xs font-normal">
                            ✓ Complete
                          </div>
                        )}
                        
                        {step.status === 'upcoming' && (
                          <div className="inline-block px-2 py-1 bg-sage-100 text-sage-600 rounded-full text-xs font-normal">
                            Coming Soon
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Mobile Roadmap */}
          <div className="lg:hidden space-y-6">
            {roadmapSteps.map((step, i) => (
              <motion.div
                key={step.title}
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.5 }}
                className="relative"
              >
                {/* Connecting Line */}
                {i < roadmapSteps.length - 1 && (
                  <div className="absolute left-6 top-16 w-0.5 h-8 bg-gradient-to-b from-primary-300 to-sage-200"></div>
                )}
                
                {/* Step Box */}
                <div className={`bg-white rounded-xl p-6 shadow-lg border-2 ml-0 transition-all duration-300 ${
                  step.status === 'completed' 
                    ? 'border-primary-300 shadow-primary-100' 
                    : step.status === 'current'
                    ? 'border-primary-500 shadow-primary-200 ring-2 ring-primary-200'
                    : 'border-sage-200 shadow-sage-100'
                }`}>
                  <div className="flex items-start space-x-4">
                    {/* Icon */}
                    <div className={`relative flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 ${
                      step.status === 'completed' 
                        ? 'bg-primary-500 text-white' 
                        : step.status === 'current'
                        ? 'bg-primary-600 text-white animate-pulse'
                        : 'bg-sage-100 text-sage-400'
                    }`}>
                      <step.icon className="w-6 h-6" />
                      
                      {step.status === 'current' && (
                        <motion.div
                          initial={{ scale: 0, opacity: 0 }}
                          whileInView={{ scale: 1, opacity: 1 }}
                          viewport={{ once: true }}
                          transition={{ delay: 1, duration: 0.5 }}
                          className="absolute -top-1 -right-1 w-4 h-4 bg-yellow-400 rounded-full flex items-center justify-center"
                        >
                          <Clock className="w-2 h-2 text-yellow-800" />
                        </motion.div>
                      )}
                    </div>
                    
                    {/* Content */}
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <h3 className={`font-semibold text-lg ${
                          step.status === 'current' ? 'text-primary-700' : 'text-sage-900'
                        }`}>
                          {step.title}
                        </h3>
                        <span className="text-sm text-primary-600 font-normal bg-primary-50 rounded-full px-3 py-1">
                          {step.date}
                        </span>
                      </div>
                      
                      <p className="text-sage-600 mb-3 leading-relaxed">
                        {step.description}
                      </p>
                      
                      {/* Status Badge */}
                      {step.status === 'current' && (
                        <motion.span
                          initial={{ opacity: 0, scale: 0 }}
                          whileInView={{ opacity: 1, scale: 1 }}
                          viewport={{ once: true }}
                          transition={{ delay: 1.5, duration: 0.5 }}
                          className="inline-block px-3 py-1 bg-yellow-100 text-yellow-700 rounded-full text-sm font-normal border border-yellow-200"
                        >
                          ← You are here
                        </motion.span>
                      )}
                      
                      {step.status === 'completed' && (
                        <span className="inline-block px-3 py-1 bg-primary-100 text-primary-700 rounded-full text-sm font-normal">
                          ✓ Complete
                        </span>
                      )}
                      
                      {step.status === 'upcoming' && (
                        <span className="inline-block px-3 py-1 bg-sage-100 text-sage-600 rounded-full text-sm font-normal">
                          Coming Soon
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
      </div>
      </section>

      {/* The Story */}
      <section className="py-16 px-4">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="bg-gradient-to-br from-white to-primary-50/30 rounded-3xl p-6 sm:p-8 lg:p-12 shadow-xl border border-sage-100"
          >
            {/* Opening Quote */}
            <div className="text-center mb-8 sm:mb-12">
              <h2 className="text-xl sm:text-2xl lg:text-3xl font-semibold text-sage-900 mb-4 sm:mb-6">
                Our Story
              </h2>
              <blockquote className="text-lg sm:text-xl lg:text-2xl font-semibold text-primary-700 italic leading-relaxed max-w-4xl mx-auto">
                "We realized we could either keep building cool projects, or build something that actually changes lives."
              </blockquote>
            </div>
            
            {/* Story Content */}
            <div className="grid lg:grid-cols-2 gap-8 lg:gap-12">
              <div className="space-y-4 sm:space-y-6">
                <div className="flex items-start space-x-3 sm:space-x-4">
                  <div className="flex-shrink-0 w-10 h-10 sm:w-12 sm:h-12 bg-primary-100 rounded-full flex items-center justify-center">
                    <Brain className="w-5 h-5 sm:w-6 sm:h-6 text-primary-600" />
                  </div>
                  <div>
                    <h3 className="text-lg sm:text-xl lg:text-2xl font-semibold text-sage-900 mb-2 sm:mb-4">
                      The Problem We Discovered
                    </h3>
                  </div>
                </div>
                
                <div className="space-y-3 sm:space-y-4 text-base sm:text-lg text-sage-700 leading-relaxed">
                  <p>
                    After talking to dozens of therapists, the same frustrations kept coming up. They were drowning in{' '}
                    <span className="font-semibold text-primary-600 bg-primary-50 px-2 py-1 rounded">
                      insurance paperwork, billing headaches, and endless documentation
                    </span>{' '}
                    requirements that had nothing to do with actual therapy.
                  </p>
                  
                  <div className="bg-primary-50 border-l-4 border-primary-500 p-4 sm:p-6 rounded-r-lg">
                    <p className="text-primary-800 italic font-normal text-sm sm:text-base">
                      "I became a therapist to help people heal, not to fight with insurance companies and spend my evenings writing notes."
                    </p>
                    <p className="text-xs sm:text-sm text-primary-600 mt-2">— What every therapist told us</p>
                  </div>
                  
                  <p>
                    They wanted to focus on the therapy part of therapy—the human connection, the healing process, the meaningful work they trained for.
                  </p>
                  
                  <p className="font-semibold text-sage-900">
                    The administrative burden was stealing their passion and burning them out. That's when we knew we had to act.
                  </p>
                </div>
              </div>
              
              <div className="space-y-4 sm:space-y-6">
                <div className="flex items-start space-x-3 sm:space-x-4">
                  <div className="flex-shrink-0 w-10 h-10 sm:w-12 sm:h-12 bg-yellow-100 rounded-full flex items-center justify-center">
                    <Zap className="w-5 h-5 sm:w-6 sm:h-6 text-yellow-600" />
                  </div>
                  <div>
                    <h3 className="text-lg sm:text-xl lg:text-2xl font-semibold text-sage-900 mb-2 sm:mb-4">
                      Our "All-In" Moment
                    </h3>
                  </div>
                </div>
                
                <div className="space-y-3 sm:space-y-4 text-base sm:text-lg text-sage-700 leading-relaxed">
                  <p>
                    We had stable careers, promising opportunities, and comfortable lives. But we couldn't stop thinking about those therapists staying late every night, stressed about admin work instead of focusing on healing.
                  </p>
                  
                  <div className="bg-yellow-50 border-l-4 border-yellow-500 p-4 sm:p-6 rounded-r-lg">
                    <p className="text-yellow-800 text-sm sm:text-base">
                      So we made the leap.{' '}
                      <span className="font-semibold text-yellow-900 bg-yellow-100 px-2 py-1 rounded">
                        We dropped everything
                      </span>{' '}
                      to build Synari—an AI-powered platform that handles the admin work so therapists can get back to what they love.
                    </p>
                  </div>
                  
                  <p className="font-semibold text-sage-900">
                    Every line of code we write is motivated by giving therapists their time back and reducing their stress.
                  </p>
                  
                  <div className="flex items-center space-x-3 pt-2 sm:pt-4">
                    <div className="w-6 h-6 sm:w-8 sm:h-8 bg-primary-500 rounded-full flex items-center justify-center">
                      <Heart className="w-3 h-3 sm:w-4 sm:h-4 text-white" />
                    </div>
                    <p className="text-sm sm:text-base font-normal text-primary-700">
                      This isn't just a business for us—it's our mission.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Transition to Team */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
        className="text-center py-6 sm:py-8"
      >
        <div className="inline-flex items-center px-4 sm:px-6 py-2 sm:py-3 rounded-full bg-gradient-to-r from-primary-500 to-primary-600 text-white mb-3 sm:mb-4">
          <Users className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
          <span className="font-normal text-sm sm:text-base">MEET THE BUILDERS</span>
        </div>
        <h2 className="text-xl sm:text-2xl font-semibold text-sage-900">The Team Behind the Mission</h2>
      </motion.div>

      {/* Founders Section */}
      <section className="py-6 sm:py-8 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-6 sm:gap-8">
            {founders.map((founder, i) => (
              <motion.div
                key={founder.name}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                variants={fadeIn}
                custom={i}
                className="bg-white rounded-2xl p-6 sm:p-8 shadow-xl border border-sage-100 hover:shadow-2xl transition-all duration-300"
              >
                {/* Initials */}
                <div className="relative mb-4 sm:mb-6">
                  <div
                    aria-hidden="true"
                    className="w-20 h-20 sm:w-24 sm:h-24 mx-auto rounded-full border-4 border-primary-200 shadow-lg bg-primary-100 text-primary-700 flex items-center justify-center text-2xl sm:text-3xl font-semibold"
                  >
                    {founder.name
                      .split(' ')
                      .map((part) => part[0])
                      .join('')}
                  </div>
                  <div className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 bg-primary-500 text-white px-2 sm:px-3 py-1 rounded-full text-xs font-normal">
                    {founder.title}
                  </div>
                </div>

                {/* Content */}
                <div className="text-center mb-4 sm:mb-6">
                  <h3 className="text-lg sm:text-xl font-semibold text-sage-900 mb-1 sm:mb-2">{founder.name}</h3>
                  <p className="text-sm sm:text-base text-sage-600 mb-2 sm:mb-3">{founder.location}</p>
                  <div className="flex justify-center gap-2 sm:gap-3 mb-3 sm:mb-4">
                    {founder.socials.map((social) => (
                      <a
                        key={social.label}
                        href={social.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-8 h-8 sm:w-10 sm:h-10 bg-primary-100 hover:bg-primary-200 rounded-full flex items-center justify-center text-primary-600 hover:text-primary-700 transition-all"
                        aria-label={social.label}
                      >
                        <social.icon className="w-4 h-4 sm:w-5 sm:h-5" />
                      </a>
                    ))}
                  </div>
                </div>

                {/* Quote */}
                <div className="bg-primary-50 rounded-lg p-3 sm:p-4 mb-4 sm:mb-6 border-l-4 border-primary-500">
                  <p className="text-primary-700 italic text-center text-xs sm:text-sm">"{founder.quote}"</p>
                </div>

                {/* Description */}
                <p className="text-sage-700 mb-3 sm:mb-4 leading-relaxed text-xs sm:text-sm">{founder.description}</p>

                {/* Skills */}
                <div className="mb-3 sm:mb-4">
                  <h4 className="text-xs sm:text-sm font-semibold text-sage-900 mb-1 sm:mb-2">Expertise</h4>
                  <div className="flex flex-wrap gap-1 sm:gap-2">
                    {founder.skills.map(skill => (
                      <span key={skill} className="bg-sage-100 text-sage-700 text-xs px-2 py-1 rounded-full font-normal">
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Achievements */}
                <div>
                  <h4 className="text-xs sm:text-sm font-semibold text-sage-900 mb-1 sm:mb-2">Highlights</h4>
                  <ul className="space-y-1">
                    {founder.achievements.map((achievement, idx) => (
                      <li key={idx} className="flex items-center text-xs sm:text-sm text-sage-700">
                        <Award className="w-3 h-3 text-primary-500 mr-2 flex-shrink-0" />
                        {achievement}
                      </li>
                    ))}
                  </ul>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-8 sm:py-12 px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="max-w-4xl mx-auto text-center"
        >
          <div className="bg-gradient-to-br from-primary-500 via-primary-600 to-primary-700 rounded-3xl p-6 sm:p-8 lg:p-10 text-white shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-64 h-64 bg-white/5 rounded-full -translate-x-32 -translate-y-32"></div>
            <div className="absolute bottom-0 right-0 w-80 h-80 bg-white/5 rounded-full translate-x-40 translate-y-40"></div>
            
            <div className="relative z-10">
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-semibold mb-3 sm:mb-4">
                Join Our Mission
              </h2>
              <p className="text-base sm:text-lg text-primary-100 mb-6 sm:mb-8 max-w-2xl mx-auto">
                Help us give therapists their time back. Be part of the AI-powered revolution in therapy practice management.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center">
                <button 
                  onClick={() => window.location.href = '/demo'}
                  className="inline-flex items-center px-6 sm:px-8 py-3 bg-white text-primary-600 font-semibold rounded-xl hover:bg-primary-50 transition-all duration-300 shadow-lg hover:shadow-xl"
                >
                  <span className="mr-2">Get a Demo</span>
                  <Rocket className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>
                <button 
                  onClick={() => window.location.href = '/'}
                  className="inline-flex items-center px-6 sm:px-8 py-3 bg-primary-400 text-white font-semibold rounded-xl hover:bg-primary-300 transition-all duration-300"
                >
                  <span className="mr-2">Explore Synari</span>
                  <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5 rotate-180" />
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      </section>
      </div>
  );
};

export default FoundersSection; 
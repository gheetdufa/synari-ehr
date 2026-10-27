import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { FaLinkedin, FaGlobe, FaGithub } from 'react-icons/fa';
import { Heart, Users, Award, Zap, Brain, Star, Mail } from 'lucide-react';
import Header from './Header';

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: 0.1 + i * 0.1, duration: 0.5 } })
};

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
                      to build Synari—a platform that handles the admin work so therapists can get back to what they love.
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
      {/* Open Source CTA */}
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
                Synari Is Open Source
              </h2>
              <p className="text-base sm:text-lg text-primary-100 mb-6 sm:mb-8 max-w-2xl mx-auto">
                Read the code, host it for your practice, or contribute on GitHub. If your practice wants help getting set up, email us.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center">
                <a
                  href="https://github.com/gheetdufa/synari-ehr"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center px-6 sm:px-8 py-3 bg-white text-primary-600 font-semibold rounded-xl hover:bg-primary-50 transition-all duration-300 shadow-lg hover:shadow-xl"
                >
                  <FaGithub className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                  <span>View on GitHub</span>
                </a>
                <a
                  href="mailto:gudadheer@gmail.com"
                  className="inline-flex items-center justify-center px-6 sm:px-8 py-3 bg-primary-400 text-white font-semibold rounded-xl hover:bg-primary-300 transition-all duration-300"
                >
                  <Mail className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                  <span>Email for Setup Help</span>
                </a>
              </div>
            </div>
          </div>
        </motion.div>
      </section>
      </div>
  );
};

export default FoundersSection; 
import { Shield, Lock, Award, ExternalLink } from 'lucide-react';
import { GoodFaithEstimateNotice } from '../shared/GoodFaithEstimateNotice';
import { Brand } from './BrandMark';
import './brand-mark.css';

const Footer = () => {
  return (
    <footer className="bg-sage-900 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Company Info */}
          <div>
            <div className="flex items-center mb-4">
              <Brand wordClassName="text-xl font-bold text-white [-webkit-text-fill-color:white] bg-none" />
            </div>
            <p className="text-sage-300 mb-4">
              AI-powered practice management designed specifically for therapists who want to spend less time on admin and more time with clients.
            </p>
          </div>

          {/* Product */}
          <div>
            <h3 className="font-semibold mb-4">Product</h3>
            <ul className="space-y-2 text-sage-300">
              <li><a href="/features" className="hover:text-white transition-colors">Features</a></li>
              <li><a href="/demo" className="hover:text-white transition-colors">Demo</a></li>
              <li><span className="text-sage-500">Integrations (Coming soon)</span></li>
              <li><span className="text-sage-500">API (Coming soon)</span></li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h3 className="font-semibold mb-4">Resources</h3>
            <ul className="space-y-2 text-sage-300">
              <li><a href="mailto:gudadheer@gmail.com" className="hover:text-white transition-colors">Contact</a></li>
              <li><span className="text-sage-500">Blog (Coming soon)</span></li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="font-semibold mb-4">Company</h3>
            <ul className="space-y-2 text-sage-300">
              <li><a href="/about" className="hover:text-white transition-colors">About</a></li>
              <li><span className="text-sage-500">Careers (Coming soon)</span></li>
            </ul>
          </div>
        </div>

        {/* Trust Badges */}
        <div className="border-t border-sage-700 mt-12 pt-8">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="flex items-center space-x-8 mb-4 md:mb-0">
              <div className="flex items-center space-x-2">
                <Lock className="w-5 h-5 text-primary-400" />
                <span className="text-sage-300">HIPAA Compliant</span>
              </div>
              <div className="flex items-center space-x-2">
                <Shield className="w-5 h-5 text-primary-400" />
                <span className="text-sage-300">HITRUST CSF</span>
              </div>
              <div className="flex items-center space-x-2">
                <Award className="w-5 h-5 text-primary-400" />
                <span className="text-sage-300">PCI Compliant</span>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <a href="#" className="text-primary-400 hover:text-primary-300 transition-colors flex items-center space-x-1">
                <span>Business Associate Agreement</span>
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>

        {/* No Surprises Act notice */}
        <div className="mt-8">
          <GoodFaithEstimateNotice dark />
        </div>

        {/* Bottom */}
        <div className="border-t border-sage-700 mt-8 pt-8 flex flex-col md:flex-row justify-between items-center text-sage-400 text-sm">
          <p>&copy; 2025 Synari. All rights reserved.</p>
          <div className="flex space-x-6 mt-4 md:mt-0">
            <a href="/privacy-policy" className="hover:text-white transition-colors">Privacy Policy</a>
            <a href="/terms-of-service" className="hover:text-white transition-colors">Terms of Service</a>
            <a href="/cookie-policy" className="hover:text-white transition-colors">Cookie Policy</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
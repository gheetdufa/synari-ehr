import { FaGithub } from 'react-icons/fa';
import { GoodFaithEstimateNotice } from '../shared/GoodFaithEstimateNotice';
import { Brand } from './BrandMark';
import './brand-mark.css';

const GITHUB_URL = 'https://github.com/gheetdufa/synari-ehr';

const Footer = () => {
  return (
    <footer className="bg-sage-900 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Project Info */}
          <div>
            <div className="flex items-center mb-4">
              <Brand wordClassName="text-xl font-bold text-white [-webkit-text-fill-color:white] bg-none" />
            </div>
            <p className="text-sage-300 mb-4">
              Open-source, self-hostable practice management for solo and group therapy practices.
            </p>
          </div>

          {/* Project */}
          <div>
            <h3 className="font-semibold mb-4">Project</h3>
            <ul className="space-y-2 text-sage-300">
              <li>
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white transition-colors inline-flex items-center space-x-2"
                >
                  <FaGithub className="w-4 h-4" />
                  <span>GitHub</span>
                </a>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h3 className="font-semibold mb-4">Resources</h3>
            <ul className="space-y-2 text-sage-300">
              <li><a href="mailto:gudadheer@gmail.com" className="hover:text-white transition-colors">Contact</a></li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="font-semibold mb-4">Company</h3>
            <ul className="space-y-2 text-sage-300">
              <li><a href="/about" className="hover:text-white transition-colors">About</a></li>
            </ul>
          </div>
        </div>

        {/* No Surprises Act notice */}
        <div className="border-t border-sage-700 mt-12 pt-8">
          <GoodFaithEstimateNotice dark />
        </div>

        {/* Bottom */}
        <div className="border-t border-sage-700 mt-8 pt-8 flex flex-col md:flex-row justify-between items-center text-sage-400 text-sm">
          <p>&copy; 2026 Synari. Open source under the AGPL-3.0 license.</p>
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

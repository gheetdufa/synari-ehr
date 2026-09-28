import Header from './Header';
import FoundersSection from './FoundersSection';
import Footer from './Footer';
import './brand-mark.css';

const AboutPage = () => {
  return (
    <div className="synari-marketing min-h-screen bg-white">
      <Header />
      <div className="pt-16"> {/* Add padding to account for fixed header */}
        <FoundersSection showHeader={false} />
      </div>
      <Footer />
    </div>
  );
};

export default AboutPage; 
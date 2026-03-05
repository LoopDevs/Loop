import { Link } from 'react-router';

export function Footer(): React.JSX.Element {
  return (
    <footer className="bg-gray-950 text-gray-400 py-12 mt-16">
      <div className="container mx-auto px-4">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3">
            <img src="/loop-logo.svg" alt="Loop" className="h-7 opacity-80" />
          </div>
          <nav className="flex flex-wrap justify-center gap-6 text-sm">
            <Link to="/" className="hover:text-white transition-colors">Directory</Link>
            <Link to="/map" className="hover:text-white transition-colors">Map</Link>
          </nav>
          <p className="text-xs text-gray-600">
            &copy; {new Date().getFullYear()} Loop. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

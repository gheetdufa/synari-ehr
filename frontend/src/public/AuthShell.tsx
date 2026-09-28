import type { ReactNode } from 'react';
import { Brand } from '../components/BrandMark';
import '../components/brand-mark.css';

/** Centered card on the brand background for sign-in style pages (password reset, invitations). */
export function AuthShell({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="synari-marketing flex min-h-screen items-center justify-center bg-gradient-to-br from-teal-600 to-teal-900 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-4 flex justify-center [&_.stack-mark]:w-12">
          <Brand withWord={false} />
        </div>
        <h1 className="mb-6 text-center text-2xl font-bold text-teal-700">{title}</h1>
        {children}
      </div>
    </div>
  );
}

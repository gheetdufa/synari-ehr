import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MAX_PASSWORD_LENGTH, PASSWORD_HINT, newPasswordError, passwordErrorField } from '../api/auth';
import { meApi } from '../api/me';
import MfaEnrollmentPage from '../auth/MfaEnrollmentPage';
import { useStaffAuth } from '../auth/StaffAuth';
import { browserTimeZone } from '../lib/format';
import { Checkbox } from '../ui/Form';
import { Brand } from './BrandMark';
import './brand-mark.css';

interface RegistrationData {
  email: string;
  password: string;
  confirmPassword: string;
  firstName: string;
  lastName: string;
  practiceName: string;
  seesClients: boolean;
  licenseNumber: string;
  licenseState: string;
}

const RegisterPage: React.FC = () => {
  const navigate = useNavigate();
  const { status, register, setSession } = useStaffAuth();
  const isAuthenticated = status === 'signedIn';
  const [formData, setFormData] = useState<RegistrationData>({
    email: '',
    password: '',
    confirmPassword: '',
    firstName: '',
    lastName: '',
    practiceName: '',
    seesClients: true,
    licenseNumber: '',
    licenseState: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  // The account exists, but the server requires two-factor authentication before anything else
  // (including saving the license below) works.
  const [enrolling, setEnrolling] = useState(false);

  // Redirect to portal if already authenticated
  useEffect(() => {
    if (isAuthenticated && !isLoading && !enrolling) {
      navigate('/portal');
    }
  }, [isAuthenticated, isLoading, enrolling, navigate]);

  const usStates = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
  ];

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const validateForm = (): string | null => {
    if (!formData.email || !formData.password || !formData.firstName || !formData.lastName) {
      return 'Please fill in all required fields';
    }
    if (formData.password !== formData.confirmPassword) {
      return 'Passwords do not match';
    }
    if (formData.seesClients && !formData.licenseNumber) {
      return 'License number is required';
    }
    if (formData.seesClients && !formData.licenseState) {
      return 'License state is required';
    }
    return null;
  };

  const saveLicense = async () => {
    if (!formData.seesClients) return;
    await setSession(
      await meApi.updateProfile({
        license_number: formData.licenseNumber,
        license_state: formData.licenseState,
      }),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const validationError = validateForm();
    const lengthError = newPasswordError(formData.password);
    setPasswordError(lengthError);
    if (validationError || lengthError) {
      setError(validationError);
      return;
    }

    setIsLoading(true);

    try {
      const session = await register({
        email: formData.email,
        password: formData.password,
        first_name: formData.firstName,
        last_name: formData.lastName,
        practice_name: formData.practiceName,
        time_zone: browserTimeZone(),
        is_clinician: formData.seesClients,
      });
      if (session.mfa_setup_required) {
        setEnrolling(true);
        setIsLoading(false);
        return;
      }
      await saveLicense();
      // Stay "loading" while leaving, so the signed-in redirect above doesn't race this one.
      navigate('/portal/settings?welcome=1');
    } catch (err) {
      if (passwordErrorField(err) === 'new') setPasswordError((err as Error).message);
      else setError(err instanceof Error ? err.message : 'Registration failed');
      setIsLoading(false);
    }
  };

  if (enrolling) {
    return (
      <MfaEnrollmentPage
        onComplete={async () => {
          await setSession();
          await saveLicense();
          navigate('/portal/settings?welcome=1');
        }}
      />
    );
  }

  return (
    <div className="synari-marketing min-h-screen bg-gradient-to-br from-sage-50 to-primary-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center [&_.stack-mark]:w-12">
          <Brand withWord={false} />
        </div>
        <h2 className="mt-6 text-center text-3xl font-semibold text-sage-900">
          Create your account
        </h2>
        <p className="mt-2 text-center text-sm text-sage-600">
          Join Synari to streamline your therapy practice
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow-xl border border-sage-100 sm:rounded-2xl sm:px-10">
          <form className="space-y-6" onSubmit={handleSubmit}>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
                {error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="firstName" className="block text-sm font-medium text-sage-700">
                  First Name *
                </label>
                <input
                  id="firstName"
                  name="firstName"
                  type="text"
                  required
                  value={formData.firstName}
                  onChange={handleInputChange}
                  className="mt-1 appearance-none block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500 sm:text-sm"
                />
              </div>
              <div>
                <label htmlFor="lastName" className="block text-sm font-medium text-sage-700">
                  Last Name *
                </label>
                <input
                  id="lastName"
                  name="lastName"
                  type="text"
                  required
                  value={formData.lastName}
                  onChange={handleInputChange}
                  className="mt-1 appearance-none block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500 sm:text-sm"
                />
              </div>
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-sage-700">
                Email address *
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={formData.email}
                onChange={handleInputChange}
                className="mt-1 appearance-none block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500 sm:text-sm"
              />
            </div>

            <div>
              <label htmlFor="practiceName" className="block text-sm font-medium text-sage-700">
                Practice name
              </label>
              <input
                id="practiceName"
                name="practiceName"
                type="text"
                value={formData.practiceName}
                onChange={handleInputChange}
                placeholder="Optional — shown to clients in emails and the portal"
                className="mt-1 appearance-none block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500 sm:text-sm"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-sage-700">
                Password *
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                maxLength={MAX_PASSWORD_LENGTH}
                aria-invalid={passwordError ? true : undefined}
                aria-describedby={passwordError ? 'password-error' : 'password-hint'}
                value={formData.password}
                onChange={handleInputChange}
                className="mt-1 appearance-none block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500 sm:text-sm"
              />
              {passwordError ? (
                <p id="password-error" className="mt-1 text-sm text-red-600">
                  {passwordError}
                </p>
              ) : (
                <p id="password-hint" className="mt-1 text-xs text-sage-500">
                  {PASSWORD_HINT}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-sage-700">
                Confirm Password *
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                maxLength={MAX_PASSWORD_LENGTH}
                value={formData.confirmPassword}
                onChange={handleInputChange}
                className="mt-1 appearance-none block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500 sm:text-sm"
              />
            </div>

            <Checkbox
              label="I see clients"
              description="Leave this on if you're a clinician. Turn it off if you run the practice and your team sees the clients."
              checked={formData.seesClients}
              onChange={(e) => setFormData((prev) => ({ ...prev, seesClients: e.target.checked }))}
            />

            {formData.seesClients && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="licenseNumber" className="block text-sm font-medium text-sage-700">
                    License Number *
                  </label>
                  <input
                    id="licenseNumber"
                    name="licenseNumber"
                    type="text"
                    required
                    value={formData.licenseNumber}
                    onChange={handleInputChange}
                    className="mt-1 appearance-none block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500 sm:text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="licenseState" className="block text-sm font-medium text-sage-700">
                    License State *
                  </label>
                  <select
                    id="licenseState"
                    name="licenseState"
                    required
                    value={formData.licenseState}
                    onChange={handleInputChange}
                    className="mt-1 block w-full px-3 py-2 border border-sage-200 rounded-lg placeholder-sage-400 focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-500 sm:text-sm"
                  >
                    <option value="">Select State</option>
                    {usStates.map(state => (
                      <option key={state} value={state}>{state}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div>
              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-semibold text-white bg-gradient-to-r from-[#0e8177] to-primary-700 hover:brightness-110 transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Creating Account...' : 'Create Account'}
              </button>
            </div>
          </form>

          <div className="mt-6">
            <div className="text-center">
              <span className="text-sm text-sage-600">
                Already have an account?{' '}
                <Link to="/login" className="font-medium text-primary-600 hover:text-primary-500">
                  Sign in
                </Link>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RegisterPage; 

import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation, Outlet, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Analytics } from '@vercel/analytics/react';
import { ClientAuthProvider, RequireClient } from './auth/ClientAuth';
import { StaffAuthProvider, RequireStaff } from './auth/StaffAuth';
import { initGA, isMarketingPath, trackPageView } from './lib/analytics';
import { queryClient } from './lib/queryClient';
import { AreaGate } from './portal/AreaGate';
import { ForgotPasswordPage, ResetPasswordPage } from './public/PasswordResetPages';
import { FullPageSpinner, SectionSpinner } from './ui/Spinner';
import { ToastProvider } from './ui/Toast';

const LandingPage = lazy(() => import('./components/LandingPage'));
const AboutPage = lazy(() => import('./components/AboutPage'));
const LoginPage = lazy(() => import('./components/LoginPage'));
const RegisterPage = lazy(() => import('./components/RegisterPage'));

const PortalLayout = lazy(() => import('./portal/PortalLayout'));
const DashboardPage = lazy(() => import('./portal/dashboard/DashboardPage'));
const CalendarPage = lazy(() => import('./portal/calendar/CalendarPage'));
const ClientsPage = lazy(() => import('./portal/clients/ClientsPage'));
const ClientDetailPage = lazy(() => import('./portal/clients/ClientDetailPage'));
const MessagesPage = lazy(() => import('./portal/messages/MessagesPage'));
const TelehealthPage = lazy(() => import('./portal/telehealth/TelehealthPage'));
const NotesPage = lazy(() => import('./portal/notes/NotesPage'));
const NoteEditorPage = lazy(() => import('./portal/notes/NoteEditorPage'));
const RecordsPage = lazy(() => import('./portal/records/RecordsPage'));
const FormsPage = lazy(() => import('./portal/forms/FormsPage'));
const TemplateEditorPage = lazy(() => import('./portal/forms/TemplateEditorPage'));
const BillingPage = lazy(() => import('./portal/billing/BillingPage'));
const ReportsPage = lazy(() => import('./portal/reports/ReportsPage'));
const ClaimsPage = lazy(() => import('./portal/insurance/claims/ClaimsPage'));
const ClaimDetailPage = lazy(() => import('./portal/insurance/claims/ClaimDetailPage'));
const RemittancesPage = lazy(() => import('./portal/insurance/remittances/RemittancesPage'));
const RemittanceDetailPage = lazy(() => import('./portal/insurance/remittances/RemittanceDetailPage'));
const SettingsPage = lazy(() => import('./portal/settings/SettingsPage'));
const SessionRoomPage = lazy(() => import('./telehealth/SessionRoomPage'));

const ClientSignInPage = lazy(() => import('./client/ClientSignInPage'));
const ClientLayout = lazy(() => import('./client/ClientLayout'));
const ClientHomePage = lazy(() => import('./client/home/ClientHomePage'));
const ClientAppointmentsPage = lazy(() => import('./client/appointments/ClientAppointmentsPage'));
const ClientBookingPage = lazy(() => import('./client/appointments/ClientBookingPage'));
const ClientMessagesPage = lazy(() => import('./client/messages/ClientMessagesPage'));
const ClientDocumentsPage = lazy(() => import('./client/documents/ClientDocumentsPage'));
const ClientFormPage = lazy(() => import('./client/documents/ClientFormPage'));
const ClientBillingPage = lazy(() => import('./client/billing/ClientBillingPage'));
const ClientRecordsPage = lazy(() => import('./client/records/ClientRecordsPage'));

const JoinPage = lazy(() => import('./public/JoinPage'));
const ShortJoinPage = lazy(() => import('./public/ShortJoinPage'));
const BookingPage = lazy(() => import('./public/BookingPage'));
const JoinPracticePage = lazy(() => import('./public/JoinPracticePage'));

// Simple wrapper to show static HTML in an iframe
const StaticHtmlPage = ({ src, title }: { src: string; title: string }) => (
  <div style={{ minHeight: '100vh', background: '#f4fbfa' }}>
    <iframe
      src={src}
      title={title}
      style={{ width: '100%', minHeight: '100vh', border: 'none', background: '#f4fbfa' }}
    />
  </div>
);

const TermsOfService = () => <StaticHtmlPage src="/terms-of-service.html" title="Terms of Service" />;
const PrivacyPolicy = () => <StaticHtmlPage src="/privacy-policy.html" title="Privacy Policy" />;
const CookiePolicy = () => <StaticHtmlPage src="/cookie-policy.html" title="Cookie Policy" />;

/** Page-view analytics for the public marketing site only; never on app or client screens. */
function AnalyticsWrapper({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  React.useEffect(() => {
    if (isMarketingPath(location.pathname)) {
      initGA();
      trackPageView(location.pathname + location.search);
    }
  }, [location]);

  return <>{children}</>;
}

const vercelAnalyticsEnabled = import.meta.env.VITE_VERCEL_ANALYTICS === 'true';

function PageSuspense() {
  return (
    <Suspense fallback={<SectionSpinner />}>
      <Outlet />
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <StaffAuthProvider>
          <ClientAuthProvider>
            <Router>
              <AnalyticsWrapper>
                <Suspense fallback={<FullPageSpinner />}>
                  <Routes>
                    <Route path="/" element={<LandingPage />} />
                    <Route path="/demo" element={<Navigate to="/" replace />} />
                    <Route path="/features" element={<Navigate to="/" replace />} />
                    <Route path="/about" element={<AboutPage />} />
                    <Route path="/terms-of-service" element={<TermsOfService />} />
                    <Route path="/privacy-policy" element={<PrivacyPolicy />} />
                    <Route path="/cookie-policy" element={<CookiePolicy />} />
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/register" element={<RegisterPage />} />
                    <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                    <Route path="/reset-password" element={<ResetPasswordPage />} />
                    <Route path="/join-practice" element={<JoinPracticePage />} />

                    <Route path="/join/:token" element={<JoinPage />} />
                    <Route path="/j/:code" element={<ShortJoinPage />} />
                    <Route path="/book/:slug" element={<BookingPage />} />

                    <Route
                      path="/portal"
                      element={
                        <RequireStaff>
                          <PortalLayout />
                        </RequireStaff>
                      }
                    >
                      <Route element={<PageSuspense />}>
                        <Route index element={<DashboardPage />} />
                        <Route path="calendar" element={<CalendarPage />} />
                        <Route path="clients" element={<ClientsPage />} />
                        <Route path="clients/:clientId" element={<ClientDetailPage />} />
                        <Route path="messaging" element={<AreaGate area="/portal/messaging"><MessagesPage /></AreaGate>} />
                        <Route path="telehealth" element={<AreaGate area="/portal/telehealth"><TelehealthPage /></AreaGate>} />
                        <Route path="notes" element={<AreaGate area="/portal/notes"><NotesPage /></AreaGate>} />
                        <Route path="notes/:noteId" element={<AreaGate area="/portal/notes"><NoteEditorPage /></AreaGate>} />
                        <Route path="records" element={<AreaGate area="/portal/records"><RecordsPage /></AreaGate>} />
                        <Route path="forms" element={<FormsPage />} />
                        <Route path="forms/templates/:templateId" element={<TemplateEditorPage />} />
                        <Route path="billing" element={<AreaGate area="/portal/billing"><BillingPage /></AreaGate>} />
                        <Route path="reports" element={<AreaGate area="/portal/reports"><ReportsPage /></AreaGate>} />
                        <Route path="billing/claims" element={<AreaGate area="/portal/billing"><ClaimsPage /></AreaGate>} />
                        <Route path="billing/claims/:claimId" element={<AreaGate area="/portal/billing"><ClaimDetailPage /></AreaGate>} />
                        <Route path="billing/remittances" element={<AreaGate area="/portal/billing"><RemittancesPage /></AreaGate>} />
                        <Route path="billing/remittances/:remittanceId" element={<AreaGate area="/portal/billing"><RemittanceDetailPage /></AreaGate>} />
                        <Route path="settings" element={<SettingsPage />} />
                      </Route>
                    </Route>
                    <Route
                      path="/session/:appointmentId"
                      element={
                        <RequireStaff>
                          <SessionRoomPage />
                        </RequireStaff>
                      }
                    />

                    <Route path="/client/sign-in" element={<ClientSignInPage />} />
                    <Route
                      path="/client"
                      element={
                        <RequireClient>
                          <ClientLayout />
                        </RequireClient>
                      }
                    >
                      <Route element={<PageSuspense />}>
                        <Route index element={<ClientHomePage />} />
                        <Route path="appointments" element={<ClientAppointmentsPage />} />
                        <Route path="appointments/book" element={<ClientBookingPage />} />
                        <Route path="messages" element={<ClientMessagesPage />} />
                        <Route path="documents" element={<ClientDocumentsPage />} />
                        <Route path="documents/forms/:formId" element={<ClientFormPage />} />
                        <Route path="billing" element={<ClientBillingPage />} />
                        <Route path="records" element={<ClientRecordsPage />} />
                      </Route>
                    </Route>
                  </Routes>
                </Suspense>
              </AnalyticsWrapper>
            </Router>
          </ClientAuthProvider>
        </StaffAuthProvider>
      </ToastProvider>
      {vercelAnalyticsEnabled && (
        <Analytics beforeSend={(event) => (isMarketingPath(new URL(event.url).pathname) ? event : null)} />
      )}
    </QueryClientProvider>
  );
}

export default App;

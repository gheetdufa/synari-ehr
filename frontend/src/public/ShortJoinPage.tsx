import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { VideoOff } from 'lucide-react';
import { api } from '../api/client';
import { EmptyState } from '../ui/Display';
import { FullPageSpinner } from '../ui/Spinner';

/** Resolves a short text-message link (/j/:code) to the full join page. */
export default function ShortJoinPage() {
  const { code = '' } = useParams();
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<{ token: string }>(`/telehealth/short/${encodeURIComponent(code)}`, { realm: null })
      .then((data) => setToken(data.token))
      .catch(() => setFailed(true));
  }, [code]);

  if (token) return <Navigate to={`/join/${token}`} replace />;
  if (!failed) return <FullPageSpinner />;
  return (
    <div className="flex min-h-screen items-center justify-center bg-sage-50 px-4">
      <EmptyState
        icon={<VideoOff />}
        title="This video link has expired"
        description="Links stop working 30 minutes after the appointment ends or if it was canceled. Check your email or client portal for the latest link."
      />
    </div>
  );
}

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video } from 'lucide-react';
import { api } from '../../api/client';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/Toast';

/**
 * "Join video" for a client's own telehealth appointment: asks the API for a fresh join link and
 * opens the shared join page (the same waiting-room flow as emailed links).
 */
export function JoinVideoButton({ appointmentId, size = 'md' }: { appointmentId: number; size?: 'sm' | 'md' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  const join = async () => {
    setLoading(true);
    try {
      const { url } = await api<{ url: string }>(`/portal/appointments/${appointmentId}/join`, { realm: 'client' });
      navigate(new URL(url).pathname);
    } catch (error) {
      toast.error(error);
      setLoading(false);
    }
  };

  return (
    <Button size={size} icon={<Video className="h-4 w-4" />} loading={loading} onClick={join}>
      Join video
    </Button>
  );
}

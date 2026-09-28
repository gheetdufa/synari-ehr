import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

describe('Modal', () => {
  it('is named by its title and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Edit client" description="Change contact details">
        <input aria-label="Name" />
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit client' });
    expect(dialog).toHaveAccessibleDescription('Change contact details');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

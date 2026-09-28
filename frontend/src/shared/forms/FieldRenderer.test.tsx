import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnswerValue, FormField } from '../../api/forms';
import type { DraftAnswers } from './answers';
import { FieldRenderer } from './FieldRenderer';
import { FormRenderer } from './FormRenderer';

function renderField(field: FormField, value?: AnswerValue, extra: { error?: string; readOnly?: boolean } = {}) {
  const onChange = vi.fn();
  const onBlur = vi.fn();
  const utils = render(
    <FieldRenderer field={field} value={value} onChange={onChange} onBlur={onBlur} idPrefix="t" {...extra} />,
  );
  return { ...utils, onChange, onBlur };
}

const CHOICES = [
  { label: 'Not at all', value: 0 },
  { label: 'Several days', value: 1 },
];

describe('FieldRenderer', () => {
  it('renders a heading as a heading', () => {
    renderField({ id: 'h', type: 'heading', label: 'About you' });
    expect(screen.getByRole('heading', { name: 'About you', level: 2 })).toBeInTheDocument();
  });

  it('renders paragraph text without an input', () => {
    const { container } = renderField({ id: 'p', type: 'paragraph', label: 'Please read.\nThen sign.' });
    expect(screen.getByText(/Please read\./)).toBeInTheDocument();
    expect(container.querySelector('input, textarea')).toBeNull();
  });

  it('renders short text with a label, required marker and help text', async () => {
    const { onChange } = renderField({ id: 'phone', type: 'short_text', label: 'Phone', required: true, help: 'Mobile is best', maps_to: 'phone' });
    const input = screen.getByRole('textbox', { name: /Phone/ });
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveAttribute('type', 'tel');
    expect(input).toHaveAttribute('autocomplete', 'tel');
    expect(input).toHaveAttribute('maxlength', '30');
    expect(input).toHaveAccessibleDescription('Mobile is best');
    expect(screen.getByText('(required)')).toHaveClass('sr-only');
    await userEvent.type(input, '5');
    expect(onChange).toHaveBeenLastCalledWith('5');
  });

  it('renders long text as a textarea and clears to undefined', () => {
    const { onChange } = renderField({ id: 'why', type: 'long_text', label: 'What brings you in?' }, 'Stress');
    const textarea = screen.getByRole('textbox', { name: 'What brings you in?' });
    expect(textarea.tagName).toBe('TEXTAREA');
    fireEvent.change(textarea, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('renders a date input that reports ISO dates', () => {
    const { onChange, container } = renderField({ id: 'dob', type: 'date', label: 'Date of birth', maps_to: 'date_of_birth' });
    const input = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(screen.getByLabelText('Date of birth')).toBe(input);
    expect(input).toHaveAttribute('max');
    fireEvent.change(input, { target: { value: '1990-04-12' } });
    expect(onChange).toHaveBeenLastCalledWith('1990-04-12');
  });

  it('renders single choice as a labelled radio group and reports the option value with its type', async () => {
    const { onChange } = renderField({ id: 'q1', type: 'single_choice', label: 'Feeling down', required: true, options: CHOICES });
    const group = screen.getByRole('radiogroup', { name: /Feeling down/ });
    expect(group.tagName).toBe('FIELDSET');
    expect(group).toHaveAttribute('aria-required', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'Several days' }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('marks the chosen radio as checked', () => {
    renderField({ id: 'q1', type: 'single_choice', label: 'Feeling down', options: CHOICES }, 0);
    expect(screen.getByRole('radio', { name: 'Not at all' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Several days' })).not.toBeChecked();
  });

  it('renders multi choice as checkboxes that add and remove values', async () => {
    const field: FormField = {
      id: 'topics',
      type: 'multi_choice',
      label: 'Topics',
      options: [
        { label: 'Sleep', value: 'sleep' },
        { label: 'Work', value: 'work' },
      ],
    };
    const { onChange, rerender } = renderField(field, ['sleep']);
    expect(screen.getByRole('group', { name: 'Topics' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Sleep' })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Work' }));
    expect(onChange).toHaveBeenLastCalledWith(['sleep', 'work']);
    rerender(<FieldRenderer field={field} value={['sleep']} onChange={onChange} idPrefix="t" />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sleep' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('renders yes/no as two radios that report booleans', async () => {
    const { onChange } = renderField({ id: 'ok', type: 'yes_no', label: 'May we text you?' });
    expect(screen.getByRole('radiogroup', { name: 'May we text you?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'No' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
    await userEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it('associates an error with the input', () => {
    renderField({ id: 'name', type: 'short_text', label: 'Name', required: true }, undefined, { error: 'This question is required' });
    const input = screen.getByRole('textbox', { name: /Name/ });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('This question is required');
  });

  it('associates an error with a choice group', () => {
    renderField({ id: 'q1', type: 'single_choice', label: 'Mood', options: CHOICES }, undefined, { error: 'Choose one of the options' });
    const group = screen.getByRole('radiogroup', { name: 'Mood' });
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(group).toHaveAccessibleDescription('Choose one of the options');
  });

  it('shows answers as text when read-only', () => {
    renderField({ id: 'q1', type: 'single_choice', label: 'Mood', options: CHOICES }, 1, { readOnly: true });
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Several days')).toBeInTheDocument();
  });

  it('says when a read-only question was not answered', () => {
    renderField({ id: 'x', type: 'short_text', label: 'Nickname' }, undefined, { readOnly: true });
    expect(screen.getByText('No answer')).toBeInTheDocument();
  });

  it('calls onBlur when leaving an input', () => {
    const { onBlur } = renderField({ id: 'x', type: 'short_text', label: 'Nickname' });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Nickname' }));
    expect(onBlur).toHaveBeenCalled();
  });
});

describe('FormRenderer', () => {
  function Harness({ fields }: { fields: FormField[] }) {
    const [answers, setAnswers] = useState<DraftAnswers>({});
    return (
      <>
        <FormRenderer
          fields={fields}
          answers={answers}
          onChange={(fieldId, value) => setAnswers((current) => ({ ...current, [fieldId]: value }))}
          idPrefix="f"
        />
        <output data-testid="answers">{JSON.stringify(answers)}</output>
      </>
    );
  }

  it('renders every field and collects answers by field id', async () => {
    render(
      <Harness
        fields={[
          { id: 'intro', type: 'heading', label: 'Welcome' },
          { id: 'name', type: 'short_text', label: 'Preferred name' },
          { id: 'ok', type: 'yes_no', label: 'OK to text?' },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Preferred name' }), 'Lex');
    await userEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    expect(JSON.parse(screen.getByTestId('answers').textContent ?? '{}')).toEqual({ name: 'Lex', ok: true });
  });
});

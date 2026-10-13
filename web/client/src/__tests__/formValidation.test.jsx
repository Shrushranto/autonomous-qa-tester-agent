import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TestForm from '../components/TestForm';

describe('TestForm Validation', () => {
  it('displays error when submitting with empty URL', () => {
    const handleSubmit = vi.fn();
    render(<TestForm onSubmit={handleSubmit} isSubmitting={false} />);

    const submitBtn = screen.getByRole('button', { name: /Generate Report/i });
    fireEvent.click(submitBtn);

    expect(screen.getByText(/Please provide a target website URL/i)).toBeDefined();
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it('displays error when URL scheme is invalid (e.g., ftp:// or file://)', () => {
    const handleSubmit = vi.fn();
    render(<TestForm onSubmit={handleSubmit} isSubmitting={false} />);

    const urlInput = screen.getByLabelText(/Target Website URL/i);
    fireEvent.change(urlInput, { target: { value: 'ftp://ftp.example.com' } });

    const submitBtn = screen.getByRole('button', { name: /Generate Report/i });
    fireEvent.click(submitBtn);

    expect(screen.getByText(/URL must start with http:\/\/ or https:\/\//i)).toBeDefined();
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it('displays error when specification file is not uploaded', () => {
    const handleSubmit = vi.fn();
    render(<TestForm onSubmit={handleSubmit} isSubmitting={false} />);

    const urlInput = screen.getByLabelText(/Target Website URL/i);
    fireEvent.change(urlInput, { target: { value: 'http://localhost:3000' } });

    const submitBtn = screen.getByRole('button', { name: /Generate Report/i });
    fireEvent.click(submitBtn);

    expect(screen.getByText(/Please upload a specification Markdown/i)).toBeDefined();
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it('quick load preset populates fields and allows submission', () => {
    const handleSubmit = vi.fn();
    render(<TestForm onSubmit={handleSubmit} isSubmitting={false} />);

    const presetBtn = screen.getByRole('button', { name: /Quick Load Demo Shop/i });
    fireEvent.click(presetBtn);

    expect(screen.getByDisplayValue('http://localhost:3000')).toBeDefined();

    const submitBtn = screen.getByRole('button', { name: /Generate Report/i });
    fireEvent.click(submitBtn);

    expect(handleSubmit).toHaveBeenCalledTimes(1);
    expect(handleSubmit).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://localhost:3000',
      specFile: expect.any(File)
    }));
  });
});

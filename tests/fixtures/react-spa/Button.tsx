import React from 'react';

interface ButtonProps {
  onClick?: () => void;
  label: string;
}

// React component with async event handlers — common pattern
export function Button({ onClick, label }: ButtonProps) {
  // handle* functions in .tsx are conventionally async even without await
  async function handleClick() {
    onClick?.();
  }

  async function onSubmit() {
    console.log('submitted');
  }

  return (
    <button onClick={handleClick} onSubmit={onSubmit}>
      {label}
    </button>
  );
}

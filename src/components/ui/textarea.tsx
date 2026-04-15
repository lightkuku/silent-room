import React from 'react';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea: React.FC<TextareaProps> = ({ 
  className = '',
  style,
  ...props 
}) => {
  const textareaStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    fontSize: '14px',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
    outline: 'none',
    resize: 'vertical',
    fontFamily: 'inherit',
    ...style,
  };

  return (
    <textarea 
      style={textareaStyle}
      {...props} 
    />
  );
};

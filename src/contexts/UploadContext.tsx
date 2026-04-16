import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface UploadContextType {
  uploads: any[];
  addUpload: (task: any) => void;
  updateUpload: (task: any) => void;
  removeUpload: (id: string) => void;
  clearUploads: () => void;
}

const UploadContext = createContext<UploadContextType | null>(null);

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploads, setUploads] = useState<any[]>([]);

  const addUpload = useCallback((task: any) => {
    setUploads(prev => [...prev, task]);
  }, []);

  const updateUpload = useCallback((task: any) => {
    setUploads(prev => {
      const exists = prev.find(u => u.id === task.id);
      if (exists) {
        return prev.map(u => u.id === task.id ? task : u);
      }
      return [...prev, task];
    });
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads(prev => prev.filter(u => u.id !== id));
  }, []);

  const clearUploads = useCallback(() => {
    setUploads([]);
  }, []);

  return (
    <UploadContext.Provider value={{ uploads, addUpload, updateUpload, removeUpload, clearUploads }}>
      {children}
    </UploadContext.Provider>
  );
}

export function useUploads() {
  const context = useContext(UploadContext);
  if (!context) {
    throw new Error('useUploads must be used within UploadProvider');
  }
  return context;
}

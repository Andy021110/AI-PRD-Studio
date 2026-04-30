"use client";

import { toast as sonnerToast } from "sonner";

type ToastVariant = "default" | "success" | "destructive";

type ToastOptions = {
  title: string;
  description?: string;
  variant?: ToastVariant;
};

export function useToast() {
  const toast = ({ title, description, variant = "default" }: ToastOptions) => {
    if (variant === "success") {
      return sonnerToast.success(title, { description });
    }

    if (variant === "destructive") {
      return sonnerToast.error(title, { description });
    }

    return sonnerToast(title, { description });
  };

  return { toast };
}


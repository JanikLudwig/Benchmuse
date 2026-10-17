"use client";

import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-brand-600 text-white hover:bg-brand-700",
        variant === "secondary" && "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
        variant === "ghost" && "text-slate-600 hover:bg-slate-100",
        variant === "danger" && "border border-red-200 bg-white text-red-700 hover:bg-red-50",
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-default disabled:border-slate-100 disabled:bg-slate-50 disabled:text-slate-800",
        className,
      )}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        "h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-default disabled:border-slate-100 disabled:bg-slate-50 disabled:text-slate-800 disabled:opacity-100",
        className,
      )}
    />
  );
}

/** Field caption. With `htmlFor` it is a real <label>; otherwise wrap it and the control in a <label>. */
export function Label({ children, hint, required, htmlFor, id }: { children: ReactNode; hint?: string; required?: boolean; htmlFor?: string; id?: string }) {
  const Tag = htmlFor ? "label" : "span";
  return (
    <Tag htmlFor={htmlFor} id={id} className="mb-1 block text-xs font-medium text-slate-600">
      {children}
      {required && <span aria-hidden className="ml-0.5 text-red-600">*</span>}
      {hint && <span className="ml-1.5 font-normal text-slate-400">{hint}</span>}
    </Tag>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {children}
    </p>
  );
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "brand" | "green" | "amber" | "red" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        tone === "slate" && "bg-slate-100 text-slate-700",
        tone === "brand" && "bg-brand-50 text-brand-700",
        tone === "green" && "bg-emerald-50 text-emerald-700",
        tone === "amber" && "bg-amber-50 text-amber-800",
        tone === "red" && "bg-red-50 text-red-700",
      )}
    >
      {children}
    </span>
  );
}

/** Native <dialog> modal: focus trapping, Escape-to-close and backdrop come from the browser. */
export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cx("m-auto w-full rounded-xl p-0 shadow-2xl backdrop:bg-slate-900/40", wide ? "max-w-2xl" : "max-w-lg")}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
        <h2 className="text-base font-semibold">{title}</h2>
        <button onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
          ✕
        </button>
      </div>
      <div className="max-h-[75vh] overflow-y-auto px-5 py-4">{open && children}</div>
    </dialog>
  );
}

export { cx };

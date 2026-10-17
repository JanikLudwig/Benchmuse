export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-900 text-sm font-bold text-white">B</span>
          <span className="text-lg font-semibold">Benchmuse</span>
        </div>
        {children}
      </div>
    </div>
  );
}

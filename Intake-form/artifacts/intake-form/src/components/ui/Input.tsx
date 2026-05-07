import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex w-full px-5 py-4 text-lg transition-all duration-200 bg-white text-slate-900 border-2 rounded-2xl border-slate-200 focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 placeholder:text-slate-400 shadow-sm hover:border-slate-300",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };

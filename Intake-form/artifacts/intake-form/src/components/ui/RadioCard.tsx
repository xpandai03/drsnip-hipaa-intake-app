import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Check } from "lucide-react";

interface RadioCardProps {
  label: string;
  selected: boolean;
  onClick: () => void;
  className?: string;
}

export function RadioCard({ label, selected, onClick, className }: RadioCardProps) {
  return (
    <motion.button
      type="button"
      whileHover={{ scale: 1.01, translateY: -2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={cn(
        "relative flex items-center justify-between w-full p-5 text-left transition-all duration-200 ease-out border-2 rounded-2xl cursor-pointer group outline-none focus-visible:ring-4 focus-visible:ring-primary/20",
        selected
          ? "border-primary bg-red-50 shadow-md shadow-primary/10"
          : "border-slate-200 bg-white hover:border-primary/40 hover:bg-slate-50 hover:shadow-lg hover:shadow-black/5",
        className
      )}
    >
      <span className={cn(
        "text-lg font-medium transition-colors",
        selected ? "text-primary" : "text-slate-800 group-hover:text-slate-900"
      )}>
        {label}
      </span>
      
      <div className={cn(
        "flex items-center justify-center w-6 h-6 rounded-full border-2 transition-colors",
        selected ? "border-primary bg-primary" : "border-slate-300 group-hover:border-primary/40"
      )}>
        {selected && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
      </div>
    </motion.button>
  );
}

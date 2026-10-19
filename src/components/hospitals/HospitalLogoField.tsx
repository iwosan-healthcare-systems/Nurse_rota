import { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readLogoFile } from "@/lib/hospital-branding";
import appLogo from "@/assets/logo.jpeg";

// Preview plus upload/remove for a hospital logo. Without one, staff see the
// application's general logo.
export function HospitalLogoField({
  value,
  onChange,
  disabled = false,
  label = "Hospital logo",
}: {
  value: string | null;
  onChange: (logo: string | null) => void | Promise<void>;
  disabled?: boolean;
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg border bg-white">
        <img
          src={value || appLogo}
          alt={value ? label : "Application logo (used until a hospital logo is added)"}
          className="h-full w-full object-contain"
        />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {value
            ? "Shown to this hospital's staff after they sign in."
            : "None yet; the application's logo is shown. PNG, JPEG, WebP or SVG."}
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="hidden"
            aria-label={`Upload ${label.toLowerCase()}`}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setError("");
              try {
                await onChange(await readLogoFile(file));
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not use this image");
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            <ImagePlus className="mr-1 h-4 w-4" /> {value ? "Change logo" : "Upload logo"}
          </Button>
          {value && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void onChange(null)}
            >
              <Trash2 className="mr-1 h-4 w-4" /> Remove
            </Button>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

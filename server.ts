import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Ensure JSON parsing middleware is enabled
app.use(express.json());

// Path to the public configs directory
const CONFIGS_DIR = path.join(process.cwd(), "public", "configs");

// Ensure the configs directory exists on startup
try {
  fs.mkdirSync(CONFIGS_DIR, { recursive: true });
  console.log(`Directory confirmed: ${CONFIGS_DIR}`);
} catch (error) {
  console.error("Error creating configs directory:", error);
}

// Serve the generated configs static directory under '/configs'
app.use("/configs", express.static(CONFIGS_DIR));

/**
 * POST /api/generate
 * Expects the user's questionnaire choices in the request body,
 * generates a valid archinstall user_configuration.json,
 * saves it under a random 5-digit ID, and returns the runner string.
 */
app.post("/api/generate", (req, res) => {
  try {
    const {
      drivePath = "/dev/nvme0n1",
      fileSystem = "ext4",
      hostname = "arch-desktop",
      desktopEnv = "kde", // kde, gnome, xfce, cinnamon
      multilib = true,
      flatpak = true,
    } = req.body;

    // Generate a cryptographically secure random 5-digit number string ID
    let randomId = "";
    do {
      randomId = Math.floor(10000 + crypto.randomInt(90000)).toString();
    } while (fs.existsSync(path.join(CONFIGS_DIR, `${randomId}.json`)));

    // 1. Build list of core packages
    // - CPU Microcode Logic: Explicitly append 'amd-ucode' since the target uses an AMD CPU.
    const packages = ["amd-ucode"];

    // - Graphics Selection: Include legacy 'nvidia-580xx-dkms' setup logic for NVIDIA Pascal.
    packages.push("nvidia-580xx-dkms");

    // - Sandboxed Appstores: flatpak packages alongside KDE 'discover' or generic package wrapper
    if (flatpak) {
      packages.push("flatpak");
      if (desktopEnv === "kde") {
        packages.push("plasma-discover", "flatpak-kcm");
      } else if (desktopEnv === "gnome") {
        packages.push("gnome-software");
      }
    }

    // 2. Desktop Profile mapping
    let profileName = "desktop";
    let profileDetails = "kde";
    if (desktopEnv === "gnome") {
      profileDetails = "gnome";
    } else if (desktopEnv === "xfce") {
      profileDetails = "xfce4";
    } else if (desktopEnv === "cinnamon") {
      profileDetails = "cinnamon";
    }

    // 3. Audio Selection: Locked to Pipewire with standard systemd bluetooth automation
    const audioBackend = "pipewire";

    // 4. Custom post-install command script list
    const customCommands: string[] = [];

    // - Flatpak Hub: Force Flathub repository target string pre-loading
    if (flatpak) {
      customCommands.push(
        "flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo"
      );
    }

    // - Display Environment Constraint: Inject X11 overrides
    // 1. Export QT_QPA_PLATFORM=xcb to system-wide environment overrides
    customCommands.push(
      "echo 'export QT_QPA_PLATFORM=xcb' >> /etc/environment"
    );

    // 2. Explicitly force DisplayServer=x11 inside sddm.conf if using sddm (standard on KDE Plasma)
    // and override Wayland configuration across environments
    customCommands.push(
      "mkdir -p /etc/sddm.conf.d",
      "echo -e '[Theme]\\n[Wayland]\\nEnableWayland=false\\n\\n[X11]\\nDisplayServer=x11' > /etc/sddm.conf"
    );

    // - Repositories: uncomment '[multilib]' profile block inside pacman.conf
    if (multilib) {
      customCommands.push(
        "sed -i '/\\[multilib\\]/,+1 s/^#//' /etc/pacman.conf"
      );
    }

    // - Audio systemd bluetooth automation
    customCommands.push(
      "systemctl enable bluetooth",
      "systemctl enable pipewire-media-session || systemctl enable wireplumber"
    );

    // 5. Structure the archinstall user_configuration.json payload
    const archConfig = {
      "archinstall-language": "English",
      "audio_backend": audioBackend,
      "audio": {
        "backend": audioBackend
      },
      "bootloader": "systemd-boot",
      "config_version": "2.6.3",
      "desktop-environment": profileDetails,
      "gfx_driver": "nvidia (proprietary)",
      "graphics-driver": "Nvidia",
      "hostname": hostname,
      "kernels": ["linux"],
      "locale": {
        "keyboard-layout": "us",
        "locale": "en_US.UTF-8"
      },
      "mirror-region": {
        "United States": [
          "https://mirrors.kernel.org/archlinux/$repo/os/$arch"
        ]
      },
      "multilib": multilib,
      "packages": packages,
      "profile": {
        "name": profileName,
        "details": profileDetails
      },
      "sys-encoding": "utf-8",
      "sys-language": "en_US",
      "timezone": "UTC",
      "disk_layouts": {
        [drivePath]: {
          "partitions": [
            {
              "boot": true,
              "size": "512MiB",
              "start": "1MiB",
              "type": "primary",
              "filesystem": {
                "format": "vfat"
              },
              "mountpoint": "/boot"
            },
            {
              "size": "100%",
              "start": "513MiB",
              "type": "primary",
              "filesystem": {
                "format": fileSystem
              },
              "mountpoint": "/"
            }
          ]
        }
      },
      "custom-commands": customCommands,
      // Leave credentials blank per security guidelines
      "users": [],
      "superuser": []
    };

    // Save configuration file
    const filePath = path.join(CONFIGS_DIR, `${randomId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(archConfig, null, 2), "utf-8");
    console.log(`Saved configuration to ${filePath}`);

    // Resolve URL host
    // Prioritize APP_URL injected by AI Studio, fallback to request headers.
    let baseHost = process.env.APP_URL;
    if (!baseHost) {
      const requestHost = req.get("host");
      baseHost = `${req.protocol}://${requestHost}`;
    }
    // Remove trailing slash if present
    baseHost = baseHost.replace(/\/$/, "");

    const configUrl = `${baseHost}/configs/${randomId}.json`;
    const terminalCommand = `archinstall --config-url ${configUrl}`;

    res.json({
      id: randomId,
      configUrl,
      command: terminalCommand,
      config: archConfig,
    });
  } catch (error: any) {
    console.error("Error generating config:", error);
    res.status(500).json({ error: "Failed to generate configuration.", details: error.message });
  }
});

// Configure Vite integration for developer flow / static fallback
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Serve fallback index.html for React Router / SPA routing
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

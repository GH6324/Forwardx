import { useEffect, useMemo, useState } from "react";
import { Bell, Download, ExternalLink, Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { mobileAuth } from "@/lib/mobileAuth";
import {
  checkMobileAppUpdate,
  defaultMobileNotificationSettings,
  getMobileNotificationSettings,
  normalizeMobileNotificationSettings,
  openMobileReleasePage,
  saveMobileNotificationSettings,
  scheduleMobileReminders,
  type MobileReminderSnapshot,
  type MobileNotificationSettings,
} from "@/lib/mobileNotifications";

export default function MobileAppSettings({ snapshot }: { snapshot: MobileReminderSnapshot }) {
  const [settings, setSettings] = useState<MobileNotificationSettings>(defaultMobileNotificationSettings);
  const [trafficThresholdInput, setTrafficThresholdInput] = useState(String(defaultMobileNotificationSettings.trafficThresholdPercent));
  const [expiryDaysInput, setExpiryDaysInput] = useState(String(defaultMobileNotificationSettings.expiryDaysBefore));
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const normalizedSnapshot = useMemo(() => snapshot, [snapshot]);

  useEffect(() => {
    if (!mobileAuth.isNative) return;
    setSettings(getMobileNotificationSettings());
  }, []);

  useEffect(() => {
    if (!mobileAuth.isNative) return;
    const next = getMobileNotificationSettings();
    if (!next.upgradeAutoCheck) return;
    checkMobileAppUpdate({ silent: true }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!mobileAuth.isNative) return;
    scheduleMobileReminders(settings, normalizedSnapshot).catch(() => undefined);
  }, [normalizedSnapshot, settings]);

  useEffect(() => {
    setTrafficThresholdInput(String(settings.trafficThresholdPercent));
  }, [settings.trafficThresholdPercent]);

  useEffect(() => {
    setExpiryDaysInput(String(settings.expiryDaysBefore));
  }, [settings.expiryDaysBefore]);

  if (!mobileAuth.isNative) return null;

  const save = async (nextSettings: MobileNotificationSettings) => {
    const next = normalizeMobileNotificationSettings(nextSettings);
    setSettings(next);
    saveMobileNotificationSettings(next);
    try {
      await scheduleMobileReminders(next, normalizedSnapshot);
      toast.success("安卓通知设置已保存");
    } catch (error: any) {
      toast.error(error?.message || "通知设置保存失败");
    }
  };

  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const result = await checkMobileAppUpdate({ silent: false });
      if (result && !result.hasUpdate) toast.success("当前 APK 已是最新版本");
    } catch (error: any) {
      toast.error(error?.message || "检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const commitTrafficThreshold = () => {
    if (!trafficThresholdInput.trim()) {
      setTrafficThresholdInput(String(settings.trafficThresholdPercent));
      return;
    }
    void save({ ...settings, trafficThresholdPercent: Number(trafficThresholdInput) });
  };

  const commitExpiryDays = () => {
    if (!expiryDaysInput.trim()) {
      setExpiryDaysInput(String(settings.expiryDaysBefore));
      return;
    }
    void save({ ...settings, expiryDaysBefore: Number(expiryDaysInput) });
  };

  return (
    <Card className="border-border/40 bg-card/60 backdrop-blur-md">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Smartphone className="h-4 w-4" />
          安卓应用设置
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/35 p-3">
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Bell className="h-4 w-4" />
                流量到期通知
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">默认关闭，剩余流量低于阈值后在指定时间提醒。</span>
            </span>
            <Switch checked={settings.trafficEnabled} onCheckedChange={(trafficEnabled) => save({ ...settings, trafficEnabled })} />
          </label>
          <div className="space-y-2 rounded-lg border border-border/50 bg-background/35 p-3">
            <Label>剩余流量阈值 (%)</Label>
            <Input
              type="number"
              min={1}
              max={99}
              value={trafficThresholdInput}
              onBlur={commitTrafficThreshold}
              onChange={(e) => setTrafficThresholdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              disabled={!settings.trafficEnabled}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/35 p-3">
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Bell className="h-4 w-4" />
                套餐到期通知
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">默认关闭，在套餐到期前指定天数提醒。</span>
            </span>
            <Switch checked={settings.expiryEnabled} onCheckedChange={(expiryEnabled) => save({ ...settings, expiryEnabled })} />
          </label>
          <div className="space-y-2 rounded-lg border border-border/50 bg-background/35 p-3">
            <Label>提前提醒天数</Label>
            <Input
              type="number"
              min={1}
              max={30}
              value={expiryDaysInput}
              onBlur={commitExpiryDays}
              onChange={(e) => setExpiryDaysInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              disabled={!settings.expiryEnabled}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2 rounded-lg border border-border/50 bg-background/35 p-3">
            <Label>提醒时间</Label>
            <Input
              type="time"
              value={settings.reminderTime}
              onChange={(e) => save({ ...settings, reminderTime: e.target.value })}
              disabled={!settings.trafficEnabled && !settings.expiryEnabled}
            />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/35 p-3">
            <span className="min-w-0">
              <span className="block text-sm font-medium">启动时自动检查 APK 更新</span>
              <span className="mt-1 block text-xs text-muted-foreground">有新版本时会询问是否前往 GitHub 下载。</span>
            </span>
            <Switch checked={settings.upgradeAutoCheck} onCheckedChange={(upgradeAutoCheck) => save({ ...settings, upgradeAutoCheck })} />
          </label>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border/50 bg-background/35 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">APK 更新</p>
            <p className="text-xs text-muted-foreground">可手动检查新版本，下载页会通过 GitHub 打开。</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="gap-2" onClick={checkUpdate} disabled={checkingUpdate}>
              {checkingUpdate ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              检查更新
            </Button>
            <Button variant="outline" size="icon" onClick={openMobileReleasePage} title="打开下载页">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

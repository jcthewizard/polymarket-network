import schedule
import time
from market_refresh_job import run_refresh_job

def job():
    """Wrapper for the refresh job."""
    try:
        run_refresh_job()
    except Exception as e:
        print(f"[SCHEDULER] Job failed: {e}")

if __name__ == '__main__':
    print("[SCHEDULER] Starting market refresh scheduler...")

    schedule.every(10).minutes.do(job)

    print("[SCHEDULER] Scheduler initialized. Will refresh every 10 minutes.")
    print("[SCHEDULER] Running initial refresh...")
    job()

    print("[SCHEDULER] Entering scheduler loop...")
    while True:
        try:
            schedule.run_pending()
            time.sleep(1)
        except KeyboardInterrupt:
            print("\n[SCHEDULER] Shutting down scheduler...")
            break
        except Exception as e:
            print(f"[SCHEDULER] Error in scheduler loop: {e}")
            time.sleep(10)

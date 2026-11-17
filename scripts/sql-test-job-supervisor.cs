using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Threading;

namespace HouseMateAi.SqlTest
{
    public sealed class ProcessResult
    {
        public int ExitCode;
        public bool RootCreated;
        public bool JobCreated;
        public bool ProcessCreated;
        public bool ProcessResumed;
        public bool JobEmptyConfirmed;
        public bool CleanupSafe;
        public bool Forced;
        public bool TerminalClose;
        public uint ProcessId;
        public string Detail;
    }

    public sealed class NativeChild
    {
        public IntPtr ProcessHandle;
        public IntPtr ThreadHandle;
        public uint ProcessId;
    }

    public static class Supervisor
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800;
        private const uint JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x00001000;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectBasicProcessIdList = 3;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
        private const uint PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
        private const uint CTRL_C_EVENT = 0;
        private const uint CTRL_BREAK_EVENT = 1;
        private const uint CTRL_CLOSE_EVENT = 2;
        private const uint CTRL_LOGOFF_EVENT = 5;
        private const uint CTRL_SHUTDOWN_EVENT = 6;
        private const int SIGNAL_CHANNEL_EOF = 255;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint WAIT_TIMEOUT = 258;
        private const uint WAIT_FAILED = 0xFFFFFFFF;
        private const uint ERROR_INSUFFICIENT_BUFFER = 122;
        private const uint ERROR_ALREADY_EXISTS = 183;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
        private const uint STANDARD_OUTPUT_HANDLE = unchecked((uint)-11);
        private const uint STANDARD_ERROR_HANDLE = unchecked((uint)-12);

        private static readonly object SignalLock = new object();
        private static readonly ManualResetEvent SignalWake = new ManualResetEvent(false);
        private static readonly HandlerRoutine ControlHandlerRoot = ControlHandler;
        private static int ControlSignalCount;
        private static int LastControlSignal;
        private static int TerminalCloseRequested;
        private static bool RunSignalPipeEnabled;
        private static List<IntPtr> SelfTestJobs;
        private static List<NativeChild> SelfTestChildren;
        private static List<string> SelfTestRoots;
        private static SelfTestFaults ActiveSelfTestFaults;

        private sealed class SelfTestFaults
        {
            public bool FailCreateJob;
            public bool FailInstallControlHandler;
            public bool FailCreateProcess;
            public bool FailResume;
            public bool FailSignalRead;
            public bool FailTerminateJob;
            public bool FailActiveProcessQueries;
            public bool CaptureProcessHandle;
            public int ActiveQueriesBeforeFailure;
            public int ActiveProcessQueryCount;
            public IntPtr CapturedProcessHandle;
        }

        private sealed class ProbeOutputCapture
        {
            private readonly object sync = new object();
            private readonly StringBuilder text = new StringBuilder();
            private readonly ManualResetEvent changed = new ManualResetEvent(false);

            public void Append(string value)
            {
                lock (sync)
                {
                    text.AppendLine(value ?? String.Empty);
                    changed.Set();
                }
            }

            public string Snapshot()
            {
                lock (sync) return text.ToString();
            }

            public bool WaitFor(string value, int timeoutMilliseconds)
            {
                Stopwatch watch = Stopwatch.StartNew();
                while (watch.ElapsedMilliseconds < timeoutMilliseconds)
                {
                    lock (sync)
                    {
                        if (text.ToString().IndexOf(value, StringComparison.Ordinal) >= 0) return true;
                        changed.Reset();
                    }
                    int remaining = timeoutMilliseconds - (int)watch.ElapsedMilliseconds;
                    if (remaining <= 0 || !changed.WaitOne(remaining)) break;
                }
                lock (sync) return text.ToString().IndexOf(value, StringComparison.Ordinal) >= 0;
            }

            public void Dispose()
            {
                changed.Dispose();
            }
        }

        private sealed class SignalProbeSession : IDisposable
        {
            private readonly Process process;
            private readonly ProbeOutputCapture output;
            private readonly Stream signalChannel;

            public SignalProbeSession(Process process, ProbeOutputCapture output)
            {
                this.process = process;
                this.output = output;
                this.signalChannel = process.StandardInput.BaseStream;
            }

            public string Output { get { return output.Snapshot(); } }
            public int ExitCode { get { return process.ExitCode; } }
            public bool HasExited { get { return process.HasExited; } }

            public bool WaitFor(string value, int timeoutMilliseconds)
            {
                return output.WaitFor(value, timeoutMilliseconds);
            }

            public void ExpectMarker(string marker, int timeoutMilliseconds, string context)
            {
                Stopwatch deadline = Stopwatch.StartNew();
                while (true)
                {
                    if (process.HasExited)
                    {
                        // Allow the redirected stdout/stderr callbacks to drain,
                        // within the same deadline, after the process exits.
                        int remaining = Math.Max(0, timeoutMilliseconds - (int)deadline.ElapsedMilliseconds);
                        if (output.WaitFor(marker, remaining)) return;
                        throw new InvalidOperationException(context + ": probe exited with code " +
                            process.ExitCode + " before '" + marker + "'." + Environment.NewLine + Output);
                    }
                    int slice = Math.Min(200, timeoutMilliseconds - (int)deadline.ElapsedMilliseconds);
                    if (slice <= 0)
                        throw new TimeoutException(context + ": probe did not report '" + marker +
                            "' within " + timeoutMilliseconds + " ms." + Environment.NewLine + Output);
                    if (output.WaitFor(marker, slice)) return;
                }
            }

            public void Send(byte signal)
            {
                signalChannel.WriteByte(signal);
                signalChannel.Flush();
            }

            public void CloseSignalChannel()
            {
                process.StandardInput.Close();
            }

            public bool WaitForExit(int timeoutMilliseconds)
            {
                if (!process.WaitForExit(timeoutMilliseconds)) return false;
                process.WaitForExit();
                return true;
            }

            public void Dispose()
            {
                try
                {
                    if (!process.HasExited)
                    {
                        // This owns only the self-test's top-level PowerShell probe.
                        // Its Job handle uses KILL_ON_JOB_CLOSE for its worker tree.
                        process.Kill();
                        if (!process.WaitForExit(5000))
                            throw new TimeoutException("Signal probe supervisor did not exit after termination.");
                    }
                }
                finally
                {
                    process.Dispose();
                    output.Dispose();
                }
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public uint cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        private delegate bool HandlerRoutine(uint controlType);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength,
            out uint returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            int attributeCount,
            uint flags,
            ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFOEX startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetHandleInformation(IntPtr handle, out uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(uint standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(
            IntPtr sourceProcess,
            IntPtr sourceHandle,
            IntPtr targetProcess,
            out IntPtr targetHandle,
            uint desiredAccess,
            bool inheritHandle,
            uint options);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetConsoleCtrlHandler(HandlerRoutine handler, bool add);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern bool CreateDirectoryW(string path, IntPtr securityAttributes);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint GetFileAttributesW(string path);

        private static Exception Win32Error(string operation)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }

        public static void RunSignalProbeChild(bool ignoreCtrlBreak)
        {
            using (ManualResetEvent stop = new ManualResetEvent(false))
            {
                HandlerRoutine handler = delegate(uint controlType)
                {
                    if (controlType != CTRL_BREAK_EVENT) return false;
                    if (!ignoreCtrlBreak) stop.Set();
                    return true;
                };
                if (!SetConsoleCtrlHandler(handler, true))
                    throw Win32Error("Could not install the signal probe child's Ctrl+Break handler.");
                try
                {
                    using (Stream input = Console.OpenStandardInput())
                    {
                        Console.WriteLine("[sql-supervisor-test] signal-child-reading-stdin");
                        if (input.ReadByte() != -1)
                            throw new IOException("Worker stdin unexpectedly contained input.");
                    }
                    Console.WriteLine("[sql-supervisor-test] worker-stdin-eof");
                    stop.WaitOne();
                    Console.WriteLine("[sql-supervisor-test] worker-ctrl-break-received");
                }
                finally
                {
                    if (!SetConsoleCtrlHandler(handler, false))
                        throw Win32Error("Could not remove the signal probe child's Ctrl+Break handler.");
                    GC.KeepAlive(handler);
                }
            }
        }

        public static ProcessResult RunSignalProbe(
            string supervisorScript,
            string powershellPath,
            string temporaryRoot,
            bool ignoreCtrlBreak,
            int timeoutMilliseconds,
            int gracefulMilliseconds,
            int terminationMilliseconds)
        {
            string arguments = "-NoProfile -NonInteractive -File " + QuoteArgument(supervisorScript) + " -SignalProbeChild";
            if (ignoreCtrlBreak) arguments += " -IgnoreCtrlBreak";
            return Run(powershellPath, arguments, Environment.CurrentDirectory, temporaryRoot,
                timeoutMilliseconds, gracefulMilliseconds, terminationMilliseconds, true);
        }

        public static string GetSystemCommandProcessor()
        {
            return GetSystemExecutable("cmd.exe");
        }

        private static string GetSystemExecutable(string fileName)
        {
            string systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
            string executable = Path.Combine(systemDirectory, fileName);
            if (!Path.IsPathRooted(executable) || !File.Exists(executable))
                throw new FileNotFoundException("The system executable was not found: " + fileName);
            return executable;
        }

        private static void EnsureWindows10OrNewer()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT ||
                Environment.OSVersion.Version.Major < 10)
            {
                throw new PlatformNotSupportedException(
                    "PROC_THREAD_ATTRIBUTE_JOB_LIST requires Windows 10 or newer.");
            }
        }

        public static string CreateOwnedTempRoot()
        {
            EnsureWindows10OrNewer();
            string parent = Path.GetFullPath(Path.GetTempPath());
            for (int attempt = 0; attempt < 8; attempt++)
            {
                string root = Path.Combine(
                    parent,
                    "housemate-ai-sql-supervisor-" + Guid.NewGuid().ToString("N"));
                if (CreateDirectoryW(root, IntPtr.Zero)) return root;
                int error = Marshal.GetLastWin32Error();
                if (error != ERROR_ALREADY_EXISTS) throw new Win32Exception(error, "CreateDirectoryW failed for the supervisor-owned temporary root.");
            }
            throw new IOException("Could not allocate a unique supervisor temporary directory.");
        }

        public static IntPtr CreateJob()
        {
            EnsureWindows10OrNewer();
            if (ActiveSelfTestFaults != null && ActiveSelfTestFaults.FailCreateJob)
            {
                ActiveSelfTestFaults.FailCreateJob = false;
                throw new Win32Exception(5, "Injected self-test failure before a Job Object was created.");
            }
            IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Win32Error("CreateJobObjectW failed.");
            try
            {
                uint flags;
                if (!GetHandleInformation(job, out flags)) throw Win32Error("GetHandleInformation failed for the Job Object.");
                if ((flags & HANDLE_FLAG_INHERIT) != 0)
                    throw new InvalidOperationException("The Job Object handle is inheritable; refusing to launch the test process.");

                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
                try
                {
                    Marshal.StructureToPtr(limits, buffer, false);
                    if (!SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        buffer,
                        (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                        throw Win32Error("SetInformationJobObject(KILL_ON_JOB_CLOSE) failed.");
                }
                finally { Marshal.FreeHGlobal(buffer); }

                JOBOBJECT_EXTENDED_LIMIT_INFORMATION verified = QueryJobLimits(job);
                uint configured = verified.BasicLimitInformation.LimitFlags;
                if ((configured & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) == 0 ||
                    (configured & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) != 0)
                    throw new InvalidOperationException("The Job Object limits do not enforce kill-on-close without breakaway.");

                return job;
            }
            catch (Exception primaryError)
            {
                try { CloseJob(job); }
                catch (Exception closeError)
                {
                    throw new AggregateException("Job configuration failed and its handle could not be closed.", new Exception[] { primaryError, closeError });
                }
                ExceptionDispatchInfo.Capture(primaryError).Throw();
                throw;
            }
        }

        private static JOBOBJECT_EXTENDED_LIMIT_INFORMATION QueryJobLimits(IntPtr job)
        {
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                uint returned;
                if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size, out returned))
                    throw Win32Error("QueryInformationJobObject(EXTENDED_LIMIT_INFORMATION) failed.");
                if (returned < size)
                    throw new IOException("QueryInformationJobObject returned a truncated extended-limit structure.");
                return (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(
                    buffer, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr CreateFileW(string name, uint access, uint share,
            IntPtr security, uint disposition, uint flags, IntPtr template);

        private static IntPtr OpenWorkerInput()
        {
            // Keep launcher control bytes exclusively on the supervisor stdin.
            IntPtr input = CreateFileW("NUL", 0x80000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (input == new IntPtr(-1)) throw Win32Error("Could not open NUL for worker stdin.");
            try
            {
                IntPtr inherited;
                if (!DuplicateHandle(GetCurrentProcess(), input, GetCurrentProcess(),
                    out inherited, 0, true, DUPLICATE_SAME_ACCESS))
                    throw Win32Error("Could not duplicate NUL for worker stdin.");
                return inherited;
            }
            finally { CloseHandle(input); }
        }

        private static IntPtr DuplicateStandardHandle(uint value)
        {
            IntPtr source = GetStdHandle(value);
            if (source == IntPtr.Zero || source == new IntPtr(-1))
                throw new InvalidOperationException("A standard console handle is unavailable; refusing to launch without output forwarding.");
            IntPtr duplicate;
            if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out duplicate, 0, true, DUPLICATE_SAME_ACCESS))
                throw Win32Error("Could not duplicate a standard console handle.");
            return duplicate;
        }

        private static IntPtr BuildEnvironmentBlock(IDictionary<string, string> overrides)
        {
            SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            IDictionary inherited = Environment.GetEnvironmentVariables();
            foreach (DictionaryEntry item in inherited)
            {
                string key = Convert.ToString(item.Key);
                string value = Convert.ToString(item.Value);
                if (!String.IsNullOrEmpty(key) && key.IndexOf('=') < 0)
                    values[key] = value ?? String.Empty;
            }
            if (overrides != null)
            {
                foreach (KeyValuePair<string, string> item in overrides)
                    values[item.Key] = item.Value ?? String.Empty;
            }
            StringBuilder block = new StringBuilder();
            foreach (KeyValuePair<string, string> item in values)
                block.Append(item.Key).Append('=').Append(item.Value).Append('\0');
            block.Append('\0');
            return Marshal.StringToHGlobalUni(block.ToString());
        }

        public static NativeChild CreateSuspendedInJob(
            IntPtr job,
            string applicationName,
            string arguments,
            string currentDirectory,
            IDictionary<string, string> environment)
        {
            EnsureWindows10OrNewer();
            if (ActiveSelfTestFaults != null && ActiveSelfTestFaults.FailCreateProcess)
            {
                ActiveSelfTestFaults.FailCreateProcess = false;
                throw new Win32Exception(5, "Injected self-test failure before CreateProcessW.");
            }
            if (job == IntPtr.Zero) throw new ArgumentException("A valid Job Object handle is required.", "job");
            if (!Path.IsPathRooted(applicationName) || !File.Exists(applicationName))
                throw new FileNotFoundException("The process application path must be absolute and exist.", applicationName);

            IntPtr attributeList = IntPtr.Zero;
            IntPtr jobList = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            IntPtr environmentBlock = IntPtr.Zero;
            IntPtr stdIn = IntPtr.Zero;
            IntPtr stdOut = IntPtr.Zero;
            IntPtr stdErr = IntPtr.Zero;
            PROCESS_INFORMATION created = new PROCESS_INFORMATION();
            bool processCreated = false;
            bool attributeListInitialized = false;
            NativeChild childResult = null;
            Exception operationError = null;
            List<Exception> cleanupErrors = new List<Exception>();
            try
            {
                stdIn = OpenWorkerInput();
                stdOut = DuplicateStandardHandle(STANDARD_OUTPUT_HANDLE);
                stdErr = DuplicateStandardHandle(STANDARD_ERROR_HANDLE);

                IntPtr required = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref required);
                int initError = Marshal.GetLastWin32Error();
                if (required == IntPtr.Zero || (initError != ERROR_INSUFFICIENT_BUFFER && initError != 0))
                    throw new Win32Exception(initError, "Could not determine the process attribute-list size.");
                attributeList = Marshal.AllocHGlobal(required);
                if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref required))
                    throw Win32Error("InitializeProcThreadAttributeList failed.");
                attributeListInitialized = true;

                jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList, job);
                if (!UpdateProcThreadAttribute(
                    attributeList, 0, new IntPtr(unchecked((int)PROC_THREAD_ATTRIBUTE_JOB_LIST)),
                    jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw Win32Error("UpdateProcThreadAttribute(JOB_LIST) failed; no worker was started.");

                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, stdIn);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, stdOut);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, stdErr);
                if (!UpdateProcThreadAttribute(
                    attributeList, 0, new IntPtr(unchecked((int)PROC_THREAD_ATTRIBUTE_HANDLE_LIST)),
                    handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                    throw Win32Error("UpdateProcThreadAttribute(HANDLE_LIST) failed; no worker was started.");

                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = stdIn;
                startup.StartupInfo.hStdOutput = stdOut;
                startup.StartupInfo.hStdError = stdErr;
                startup.lpAttributeList = attributeList;

                string command = QuoteArgument(applicationName);
                if (!String.IsNullOrEmpty(arguments)) command += " " + arguments;
                StringBuilder mutableCommand = new StringBuilder(command);
                environmentBlock = BuildEnvironmentBlock(environment);
                uint flags = CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP |
                    CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
                if (!CreateProcessW(
                    applicationName, mutableCommand, IntPtr.Zero, IntPtr.Zero, true,
                    flags, environmentBlock, currentDirectory, ref startup, out created))
                    throw Win32Error("CreateProcessW failed while assigning the worker to its Job Object.");
                processCreated = true;

                childResult = new NativeChild();
                childResult.ProcessHandle = created.hProcess;
                childResult.ThreadHandle = created.hThread;
                childResult.ProcessId = created.dwProcessId;
            }
            catch (Exception error)
            {
                operationError = error;
                if (processCreated)
                {
                    if (!TerminateProcess(created.hProcess, 1)) cleanupErrors.Add(Win32Error("TerminateProcess failed while aborting a partially created suspended worker."));
                    try
                    {
                        if (!WaitProcess(created.hProcess, 5000))
                            cleanupErrors.Add(new TimeoutException("A partially created suspended worker did not exit."));
                    }
                    catch (Exception waitError) { cleanupErrors.Add(waitError); }
                    if (!CloseHandle(created.hThread)) cleanupErrors.Add(Win32Error("CloseHandle(partial worker thread) failed."));
                    if (!CloseHandle(created.hProcess)) cleanupErrors.Add(Win32Error("CloseHandle(partial worker process) failed."));
                }
            }
            finally
            {
                if (attributeList != IntPtr.Zero)
                {
                    if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
                if (stdIn != IntPtr.Zero && !CloseHandle(stdIn)) cleanupErrors.Add(Win32Error("CloseHandle(duplicated stdin) failed."));
                if (stdOut != IntPtr.Zero && !CloseHandle(stdOut)) cleanupErrors.Add(Win32Error("CloseHandle(duplicated stdout) failed."));
                if (stdErr != IntPtr.Zero && !CloseHandle(stdErr)) cleanupErrors.Add(Win32Error("CloseHandle(duplicated stderr) failed."));
            }

            if (cleanupErrors.Count > 0)
            {
                if (childResult != null)
                {
                    if (!TerminateProcess(childResult.ProcessHandle, 1)) cleanupErrors.Add(Win32Error("TerminateProcess failed after inherited-handle cleanup failed."));
                    try
                    {
                        if (!WaitProcess(childResult.ProcessHandle, 5000))
                            cleanupErrors.Add(new TimeoutException("Worker did not exit after inherited-handle cleanup failed."));
                    }
                    catch (Exception waitError) { cleanupErrors.Add(waitError); }
                    if (childResult.ThreadHandle != IntPtr.Zero)
                    {
                        if (CloseHandle(childResult.ThreadHandle)) childResult.ThreadHandle = IntPtr.Zero;
                        else cleanupErrors.Add(Win32Error("CloseHandle(worker thread after launch failure) failed."));
                    }
                    if (childResult.ProcessHandle != IntPtr.Zero)
                    {
                        if (CloseHandle(childResult.ProcessHandle)) childResult.ProcessHandle = IntPtr.Zero;
                        else cleanupErrors.Add(Win32Error("CloseHandle(worker process after launch failure) failed."));
                    }
                }
                if (operationError != null) cleanupErrors.Insert(0, operationError);
                throw new AggregateException("Worker creation or native handle cleanup failed.", cleanupErrors);
            }
            if (operationError != null) ExceptionDispatchInfo.Capture(operationError).Throw();
            return childResult;
        }

        private static void CaptureSelfTestProcessHandle(NativeChild child)
        {
            if (ActiveSelfTestFaults == null || !ActiveSelfTestFaults.CaptureProcessHandle) return;
            IntPtr duplicate;
            if (!DuplicateHandle(
                GetCurrentProcess(), child.ProcessHandle, GetCurrentProcess(),
                out duplicate, 0, false, DUPLICATE_SAME_ACCESS))
                throw Win32Error("Could not retain a self-test wait handle for the exact worker process.");
            ActiveSelfTestFaults.CapturedProcessHandle = duplicate;
        }

        public static bool IsMember(IntPtr process, IntPtr job)
        {
            bool member;
            if (!IsProcessInJob(process, job, out member)) throw Win32Error("IsProcessInJob failed.");
            return member;
        }

        public static bool IsJobHandleInheritable(IntPtr job)
        {
            uint flags;
            if (!GetHandleInformation(job, out flags)) throw Win32Error("GetHandleInformation failed.");
            return (flags & HANDLE_FLAG_INHERIT) != 0;
        }

        public static uint Resume(NativeChild child)
        {
            uint result = ResumeThread(child.ThreadHandle);
            if (result == WAIT_FAILED) throw Win32Error("ResumeThread failed; worker remains suspended.");
            if (result != 1)
                throw new InvalidOperationException("The initial thread did not have the expected single suspended state.");
            return result;
        }

        public static bool TerminateExactProcess(NativeChild child, uint exitCode)
        {
            return TerminateProcess(child.ProcessHandle, exitCode);
        }

        public static bool TerminateJob(IntPtr job, uint exitCode)
        {
            int error;
            return TerminateJob(job, exitCode, out error);
        }

        private static bool TerminateJob(IntPtr job, uint exitCode, out int error)
        {
            if (ActiveSelfTestFaults != null && ActiveSelfTestFaults.FailTerminateJob)
            {
                ActiveSelfTestFaults.FailTerminateJob = false;
                error = 5; // Injected result, independent of Win32 thread state.
                return false;
            }
            bool result = TerminateJobObject(job, exitCode);
            error = result ? 0 : Marshal.GetLastWin32Error();
            return result;
        }

        public static uint ActiveProcessCount(IntPtr job)
        {
            if (ActiveSelfTestFaults != null) ActiveSelfTestFaults.ActiveProcessQueryCount++;
            if (ActiveSelfTestFaults != null && ActiveSelfTestFaults.FailActiveProcessQueries)
            {
                if (ActiveSelfTestFaults.ActiveQueriesBeforeFailure > 0)
                    ActiveSelfTestFaults.ActiveQueriesBeforeFailure--;
                else
                    throw new IOException("Injected self-test failure querying Job process state.");
            }
            // Close handles to exited Job members before waiting for this count
            // to reach zero; Windows decrements it after process references drop.
            IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)));
            try
            {
                uint returned;
                if (!QueryInformationJobObject(
                    job, JobObjectBasicAccountingInformation, buffer,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), out returned))
                    throw Win32Error("QueryInformationJobObject(BASIC_ACCOUNTING_INFORMATION) failed.");
                if (returned < Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)))
                    throw new IOException("QueryInformationJobObject returned a truncated accounting structure.");
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info =
                    (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                        buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
                return info.ActiveProcesses;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        public static uint[] ProcessIds(IntPtr job)
        {
            int capacity = 16;
            for (int attempt = 0; attempt < 8; attempt++)
            {
                int headerSize = 8;
                int bytes = checked(headerSize + (capacity * IntPtr.Size));
                IntPtr buffer = Marshal.AllocHGlobal(bytes);
                try
                {
                    uint returned;
                    if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)bytes, out returned))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error == ERROR_INSUFFICIENT_BUFFER) { capacity *= 2; continue; }
                        throw new Win32Exception(error, "QueryInformationJobObject(BASIC_PROCESS_ID_LIST) failed.");
                    }
                    uint assigned = unchecked((uint)Marshal.ReadInt32(buffer, 0));
                    uint count = unchecked((uint)Marshal.ReadInt32(buffer, 4));
                    if (returned < headerSize)
                        throw new IOException("QueryInformationJobObject returned a truncated process-list header.");
                    if (count > capacity) { capacity = checked((int)count); continue; }
                    if (returned < headerSize + (count * IntPtr.Size))
                        throw new IOException("QueryInformationJobObject returned a truncated process ID list.");
                    uint[] ids = new uint[count];
                    for (int i = 0; i < count; i++)
                    {
                        IntPtr value = Marshal.ReadIntPtr(buffer, headerSize + (i * IntPtr.Size));
                        ids[i] = IntPtr.Size == 8 ? unchecked((uint)value.ToInt64()) : unchecked((uint)value.ToInt32());
                    }
                    if (assigned > count && count == capacity) { capacity = checked((int)assigned); continue; }
                    return ids;
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            throw new IOException("Could not obtain a stable process list for the Job Object.");
        }

        public static bool WaitProcess(IntPtr process, int timeoutMilliseconds)
        {
            uint result = WaitForSingleObject(process, unchecked((uint)timeoutMilliseconds));
            if (result == WAIT_OBJECT_0) return true;
            if (result == WAIT_TIMEOUT) return false;
            if (result == WAIT_FAILED) throw Win32Error("WaitForSingleObject(process) failed.");
            throw new IOException("WaitForSingleObject(process) returned an unexpected result.");
        }

        public static uint ExitCode(IntPtr process)
        {
            uint value;
            if (!GetExitCodeProcess(process, out value)) throw Win32Error("GetExitCodeProcess failed.");
            return value;
        }

        public static bool RequestGracefulStop(uint processGroupId)
        {
            return GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, processGroupId);
        }

        public static void CloseNativeChild(NativeChild child)
        {
            if (child == null) return;
            List<Exception> errors = new List<Exception>();
            if (child.ThreadHandle != IntPtr.Zero)
            {
                if (CloseHandle(child.ThreadHandle)) child.ThreadHandle = IntPtr.Zero;
                else errors.Add(Win32Error("CloseHandle(worker thread) failed."));
            }
            if (child.ProcessHandle != IntPtr.Zero)
            {
                if (CloseHandle(child.ProcessHandle)) child.ProcessHandle = IntPtr.Zero;
                else errors.Add(Win32Error("CloseHandle(worker process) failed."));
            }
            if (errors.Count == 1) throw errors[0];
            if (errors.Count > 1) throw new AggregateException("Worker process handles could not all be closed.", errors);
        }

        public static void CloseJob(IntPtr job)
        {
            if (job != IntPtr.Zero && !CloseHandle(job)) throw Win32Error("CloseHandle(Job Object) failed.");
        }

        public static bool CanDeleteRoot(bool cleanupSafe, bool terminalClose)
        {
            return cleanupSafe && !terminalClose;
        }

        public static bool IsOwnedRootDirectory(string root)
        {
            if (String.IsNullOrWhiteSpace(root)) return false;
            string full = Path.GetFullPath(root);
            string parent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullParent = Path.GetDirectoryName(full).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string name = Path.GetFileName(full);
            const string prefix = "housemate-ai-sql-supervisor-";
            Guid runId;
            if (!String.Equals(parent, fullParent, StringComparison.OrdinalIgnoreCase) ||
                !name.StartsWith(prefix, StringComparison.Ordinal) ||
                !Guid.TryParseExact(name.Substring(prefix.Length), "N", out runId))
                throw new InvalidOperationException("Refusing to remove a temporary path not created by this supervisor.");
            uint attributes = GetFileAttributesW(full);
            if (attributes == 0xFFFFFFFF) throw Win32Error("Could not inspect the supervisor temporary root before cleanup.");
            if ((attributes & 0x10) == 0 || (attributes & 0x400) != 0)
                throw new InvalidOperationException("Refusing to remove a non-directory or reparse-point supervisor root.");
            return true;
        }

        public static bool TryDeleteOwnedRoot(string root, bool cleanupSafe, bool terminalClose)
        {
            if (!CanDeleteRoot(cleanupSafe, terminalClose)) return false;
            if (!IsOwnedRootDirectory(root)) return false;
            string full = Path.GetFullPath(root);
            Directory.Delete(full, true);
            return true;
        }

        private static bool InstallControlHandler()
        {
            if (ActiveSelfTestFaults != null && ActiveSelfTestFaults.FailInstallControlHandler)
            {
                ActiveSelfTestFaults.FailInstallControlHandler = false;
                return false;
            }
            lock (SignalLock)
            {
                ControlSignalCount = 0;
                LastControlSignal = 0;
                TerminalCloseRequested = 0;
                SignalWake.Reset();
            }
            return SetConsoleCtrlHandler(ControlHandlerRoot, true);
        }

        private static bool RemoveControlHandler(out int error)
        {
            bool removed = SetConsoleCtrlHandler(ControlHandlerRoot, false);
            error = removed ? 0 : Marshal.GetLastWin32Error();
            lock (SignalLock)
            {
                SignalWake.Reset();
            }
            return removed;
        }

        private static bool ControlHandler(uint controlType)
        {
            if (controlType == CTRL_C_EVENT || controlType == CTRL_BREAK_EVENT)
            {
                if (!RunSignalPipeEnabled)
                {
                    RecordSignal(controlType == CTRL_C_EVENT ? 130 : 149);
                }
                return true;
            }
            if (controlType == CTRL_CLOSE_EVENT || controlType == CTRL_LOGOFF_EVENT || controlType == CTRL_SHUTDOWN_EVENT)
            {
                Interlocked.Exchange(ref TerminalCloseRequested, 1);
                SignalWake.Set();
                return true;
            }
            return false;
        }

        private static void RecordSignal(int exitCode)
        {
            lock (SignalLock)
            {
                ControlSignalCount += 1;
                LastControlSignal = exitCode;
            }
            SignalWake.Set();
        }

        private static int SignalExitCode(int signal)
        {
            if (signal == SIGNAL_CHANNEL_EOF) return 1;
            return signal == 0 ? 130 : signal;
        }

        private static void StartSignalPipeReader()
        {
            bool injectReadFailure = ActiveSelfTestFaults != null && ActiveSelfTestFaults.FailSignalRead;
            Thread reader = new Thread(delegate()
            {
                try
                {
                    if (injectReadFailure) throw new IOException("Injected signal channel read failure.");
                    Stream input = Console.OpenStandardInput();
                    while (true)
                    {
                        int signal = input.ReadByte();
                        if (signal < 0)
                        {
                            RecordSignal(SIGNAL_CHANNEL_EOF);
                            return;
                        }
                        if (signal == 129 || signal == 130 || signal == 143 || signal == 149)
                            RecordSignal(signal);
                    }
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine("[sql-supervisor] signal-channel-read-failed: " + error.Message);
                    RecordSignal(1);
                }
            });
            reader.IsBackground = true;
            reader.Name = "housemate-sql-supervisor-signal-reader";
            reader.Start();
        }

        public static ProcessResult Run(
            string applicationName,
            string arguments,
            string workingDirectory,
            string temporaryRoot,
            int timeoutMilliseconds,
            int gracefulMilliseconds,
            int terminationMilliseconds,
            bool readSignalPipe)
        {
            ProcessResult result = new ProcessResult();
            result.ExitCode = 1;
            result.Detail = "not-started";
            IntPtr job = IntPtr.Zero;
            NativeChild child = null;
            bool handlerInstalled = false;
            bool cleanupFailure = false;
            bool forceRequested = false;
            bool gracefulSent = false;
            bool rootExited = false;
            bool assignmentRejected = false;
            bool launcherEof = false;
            int signalExitCode = 0;
            Stopwatch runtime = Stopwatch.StartNew();
            Stopwatch gracefulWait = null;
            Stopwatch descendantDrain = null;
            try
            {
                result.RootCreated = IsOwnedRootDirectory(temporaryRoot);
                if (!result.RootCreated)
                    throw new InvalidOperationException("The supervisor temporary root was not created by this execution.");

                RunSignalPipeEnabled = readSignalPipe;
                if (!InstallControlHandler()) throw Win32Error("SetConsoleCtrlHandler failed; refusing to start SQL tests.");
                handlerInstalled = true;
                if (readSignalPipe)
                {
                    StartSignalPipeReader();
                    Console.WriteLine("[sql-supervisor] signal-pipe-ready");
                }
                job = CreateJob();
                result.JobCreated = true;
                Console.WriteLine("[sql-supervisor] job-created kill-on-close=true breakaway=false");
                if (ActiveProcessCount(job) != 0)
                    throw new InvalidOperationException("A newly created Job Object was not empty.");
                result.JobEmptyConfirmed = true;

                Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                string tempParent = Path.GetDirectoryName(Path.GetFullPath(temporaryRoot));
                environment["HOUSEMATE_SQL_TEST_SUPERVISED"] = "1";
                environment["HOUSEMATE_SQL_TEST_TMP_ROOT"] = Path.GetFullPath(temporaryRoot);
                environment["HOUSEMATE_SQL_TEST_TMP_PARENT"] = tempParent;
                environment["TEMP"] = Path.GetFullPath(temporaryRoot);
                environment["TMP"] = Path.GetFullPath(temporaryRoot);
                result.JobEmptyConfirmed = false;
                child = CreateSuspendedInJob(job, applicationName, arguments, workingDirectory, environment);
                result.ProcessCreated = true;
                result.JobEmptyConfirmed = false;
                result.ProcessId = child.ProcessId;
                CaptureSelfTestProcessHandle(child);
                Console.WriteLine("[sql-supervisor] process-created-suspended pid=" + child.ProcessId);
                if (!IsMember(child.ProcessHandle, job))
                {
                    assignmentRejected = true;
                    result.Detail = "membership-verification-failed";
                    if (!TerminateExactProcess(child, 1)) throw Win32Error("Could not terminate the suspended process after membership verification failed.");
                    if (!WaitProcess(child.ProcessHandle, 5000))
                        throw new TimeoutException("The suspended process did not exit after its Job membership check failed.");
                    throw new InvalidOperationException("Initial process was not a member of the created Job Object; tests were not resumed.");
                }
                Console.WriteLine("[sql-supervisor] membership-verified pid=" + child.ProcessId);
                int signalsBeforeResume;
                int signalBeforeResume;
                lock (SignalLock)
                {
                    signalsBeforeResume = ControlSignalCount;
                    signalBeforeResume = LastControlSignal;
                }
                if (Volatile.Read(ref TerminalCloseRequested) != 0 || signalsBeforeResume > 0)
                {
                    result.TerminalClose = Volatile.Read(ref TerminalCloseRequested) != 0;
                    launcherEof = signalBeforeResume == SIGNAL_CHANNEL_EOF;
                    result.Detail = launcherEof ? "launcher-channel-eof-before-resume" : "termination-requested-before-resume";
                    signalExitCode = signalBeforeResume == 0 ? 130 : SignalExitCode(signalBeforeResume);
                    forceRequested = true;
                }
                else
                {
                    if (ActiveSelfTestFaults != null && ActiveSelfTestFaults.FailResume)
                        throw new Win32Exception(5, "Injected ResumeThread failure.");
                    Resume(child);
                    result.ProcessResumed = true;
                    result.Detail = "running";
                    Console.WriteLine("[sql-supervisor] process-resumed pid=" + child.ProcessId);

                    uint lastReportedActive = UInt32.MaxValue;
                    while (true)
                    {
                        int signals;
                        int lastSignal;
                        lock (SignalLock)
                        {
                            signals = ControlSignalCount;
                            lastSignal = LastControlSignal;
                        }

                        if (Volatile.Read(ref TerminalCloseRequested) != 0)
                        {
                            result.TerminalClose = true;
                            result.Detail = "terminal-close-requested";
                            forceRequested = true;
                        }
                        else if (signals >= 2)
                        {
                            launcherEof = lastSignal == SIGNAL_CHANNEL_EOF;
                            signalExitCode = lastSignal == 0 ? 130 : SignalExitCode(lastSignal);
                            result.Detail = launcherEof ? "launcher-eof-forced-termination" : "second-signal-forced-termination";
                            forceRequested = true;
                        }
                        else if (signals == 1 && !gracefulSent)
                        {
                            launcherEof = lastSignal == SIGNAL_CHANNEL_EOF;
                            signalExitCode = lastSignal == 0 ? 130 : SignalExitCode(lastSignal);
                            gracefulSent = true;
                            gracefulWait = Stopwatch.StartNew();
                            result.Detail = launcherEof ? "launcher-channel-eof" : "signal-graceful-shutdown";
                            Console.WriteLine("[sql-supervisor] " + (launcherEof ? "launcher-eof" : "first-signal") + "-forwarding-ctrl-break group=" + result.ProcessId);
                            if (!RequestGracefulStop(result.ProcessId))
                            {
                                int error = Marshal.GetLastWin32Error();
                                Console.Error.WriteLine("[sql-supervisor] GenerateConsoleCtrlEvent failed win32=" + error);
                                result.Detail = "graceful-signal-forward-failed";
                                forceRequested = true;
                            }
                        }

                        if (runtime.ElapsedMilliseconds >= timeoutMilliseconds && !rootExited)
                        {
                            result.Detail = "worker-timeout";
                            forceRequested = true;
                        }
                        if (gracefulWait != null && gracefulWait.ElapsedMilliseconds >= gracefulMilliseconds)
                        {
                            result.Detail = launcherEof ? "launcher-eof-graceful-timeout" : "graceful-shutdown-timeout";
                            forceRequested = true;
                        }

                        uint processWait = child == null
                            ? WAIT_TIMEOUT
                            : WaitForSingleObject(child.ProcessHandle, 0);
                        if (processWait == WAIT_OBJECT_0 && child != null && !rootExited)
                        {
                            rootExited = true;
                            result.ExitCode = unchecked((int)ExitCode(child.ProcessHandle));
                            Console.WriteLine("[sql-supervisor] root-exited pid=" + child.ProcessId + " code=" + result.ExitCode);
                            CloseNativeChild(child);
                            child = null;
                            descendantDrain = Stopwatch.StartNew();
                        }
                        else if (processWait == WAIT_FAILED)
                        {
                            throw Win32Error("WaitForSingleObject failed while monitoring the worker.");
                        }

                        uint active = ActiveProcessCount(job);
                        if (active != lastReportedActive)
                        {
                            Console.WriteLine("[sql-supervisor] active-processes=" + active);
                            lastReportedActive = active;
                        }
                        if (active == 0)
                        {
                            result.JobEmptyConfirmed = true;
                            if (rootExited)
                            {
                                if (gracefulSent) result.ExitCode = signalExitCode == 0 ? 130 : signalExitCode;
                                if (result.Detail == "running") result.Detail = "normal-exit";
                                break;
                            }
                            throw new InvalidOperationException("The Job became empty before the root process exit could be read.");
                        }

                        if (rootExited && !gracefulSent && descendantDrain != null && descendantDrain.ElapsedMilliseconds >= 10000)
                        {
                            result.Detail = "descendants-remained-after-root-exit";
                            forceRequested = true;
                        }

                        if (forceRequested) break;
                        SignalWake.WaitOne(100);
                    }
                }

                if (forceRequested && !result.JobEmptyConfirmed)
                {
                    result.Forced = true;
                    int signalsAtTermination;
                    lock (SignalLock) signalsAtTermination = ControlSignalCount;
                    if (signalExitCode != 0) result.ExitCode = signalExitCode;
                    else result.ExitCode = 1;
                    int error;
                    bool terminated = TerminateJob(job, unchecked((uint)result.ExitCode), out error);
                    if (!terminated)
                    {
                        Console.Error.WriteLine("[sql-supervisor] TerminateJobObject failed win32=" + error);
                    }
                    else Console.WriteLine("[sql-supervisor] TerminateJobObject requested");
                    if (child != null)
                    {
                        if (WaitProcess(child.ProcessHandle, terminationMilliseconds))
                        {
                            rootExited = true;
                            CloseNativeChild(child);
                            child = null;
                        }
                    }
                    result.JobEmptyConfirmed = child == null && WaitForJobEmpty(job, terminationMilliseconds);
                    int signalsAfterTermination;
                    int lastSignalAfterTermination;
                    lock (SignalLock)
                    {
                        signalsAfterTermination = ControlSignalCount;
                        lastSignalAfterTermination = LastControlSignal;
                    }
                    if (signalsAfterTermination > signalsAtTermination)
                    {
                        int laterExitCode = SignalExitCode(lastSignalAfterTermination);
                        result.ExitCode = laterExitCode == 0 ? 1 : laterExitCode;
                        Console.WriteLine("[sql-supervisor] additional-signal-observed-during-cleanup exit_code=" + result.ExitCode);
                    }
                    result.CleanupSafe = result.JobEmptyConfirmed && !result.TerminalClose;
                    if (result.JobEmptyConfirmed) Console.WriteLine("[sql-supervisor] job-empty active_processes=0");
                    else
                    {
                        result.CleanupSafe = false;
                        Console.Error.WriteLine("[sql-supervisor] job-not-empty root-retained active=" + SafeActiveCount(job));
                    }
                }
                else if (result.JobEmptyConfirmed)
                {
                    result.CleanupSafe = !result.TerminalClose;
                }
            }
            catch (Exception error)
            {
                result.ExitCode = result.ExitCode == 0 ? 1 : result.ExitCode;
                result.Detail = "supervisor-error: " + error.Message;
                Console.Error.WriteLine("[sql-supervisor] " + result.Detail);
                if (job != IntPtr.Zero)
                {
                    int terminationError;
                    bool requested = TerminateJob(job, 1, out terminationError);
                    if (!requested) Console.Error.WriteLine("[sql-supervisor] fallback TerminateJobObject failed win32=" + terminationError);
                    try
                    {
                        if (child != null && WaitProcess(child.ProcessHandle, terminationMilliseconds))
                        {
                            CloseNativeChild(child);
                            child = null;
                        }
                        if (child == null) result.JobEmptyConfirmed = WaitForJobEmpty(job, terminationMilliseconds);
                    }
                    catch (Exception waitError) { Console.Error.WriteLine("[sql-supervisor] job-state-check-failed: " + waitError.Message); }
                }
            }
            finally
            {
                if (Volatile.Read(ref TerminalCloseRequested) != 0)
                {
                    result.TerminalClose = true;
                    result.CleanupSafe = false;
                    if (result.ExitCode == 0) result.ExitCode = 1;
                }
                int removalError;
                if (handlerInstalled && !RemoveControlHandler(out removalError))
                {
                    cleanupFailure = true;
                    result.ExitCode = result.ExitCode == 0 ? 1 : result.ExitCode;
                    result.Detail = "control-handler-removal-failed";
                    Console.Error.WriteLine("[sql-supervisor] SetConsoleCtrlHandler(remove) failed win32=" + removalError);
                    result.CleanupSafe = false;
                }
                RunSignalPipeEnabled = false;
                if (child != null)
                {
                    try { CloseNativeChild(child); }
                    catch (Exception closeError)
                    {
                        cleanupFailure = true;
                        result.CleanupSafe = false;
                        result.ExitCode = result.ExitCode == 0 ? 1 : result.ExitCode;
                        Console.Error.WriteLine("[sql-supervisor] child-handle-close-failed: " + closeError.Message);
                    }
                }
                if (job != IntPtr.Zero)
                {
                    if (!result.JobEmptyConfirmed)
                        Console.Error.WriteLine("[sql-supervisor] closing last Job handle as kill-on-close fallback; root retained");
                    try
                    {
                        CloseJob(job);
                        job = IntPtr.Zero;
                    }
                    catch (Exception closeError)
                    {
                        cleanupFailure = true;
                        result.CleanupSafe = false;
                        result.ExitCode = result.ExitCode == 0 ? 1 : result.ExitCode;
                        Console.Error.WriteLine("[sql-supervisor] Job handle close failed: " + closeError.Message);
                    }
                }
            }

            if (job == IntPtr.Zero && !result.JobCreated && !result.ProcessCreated)
                result.CleanupSafe = result.RootCreated && !result.TerminalClose && !assignmentRejected;
            else if (job != IntPtr.Zero && !result.JobEmptyConfirmed && child == null)
            {
                try { result.JobEmptyConfirmed = ActiveProcessCount(job) == 0; }
                catch (Exception stateError) { Console.Error.WriteLine("[sql-supervisor] final-job-state-unavailable: " + stateError.Message); }
                result.CleanupSafe = result.JobEmptyConfirmed && !result.TerminalClose && !assignmentRejected;
            }
            else if (result.JobEmptyConfirmed)
                result.CleanupSafe = result.RootCreated && !result.TerminalClose && !assignmentRejected;
            else
                result.CleanupSafe = false;

            int finalSignalCount;
            int finalSignal;
            lock (SignalLock)
            {
                finalSignalCount = ControlSignalCount;
                finalSignal = LastControlSignal;
            }
            if (finalSignalCount > 0 && result.ExitCode == 0)
            {
                int observedExitCode = SignalExitCode(finalSignal);
                result.ExitCode = observedExitCode == 0 ? 1 : observedExitCode;
            }
            if (Volatile.Read(ref TerminalCloseRequested) != 0)
            {
                result.TerminalClose = true;
                result.CleanupSafe = false;
            }
            if (cleanupFailure || result.TerminalClose || !result.CleanupSafe)
            {
                result.CleanupSafe = false;
                if (result.ExitCode == 0) result.ExitCode = 1;
            }
            Console.WriteLine("[sql-supervisor] result detail=" + result.Detail +
                " pid=" + result.ProcessId + " root_created=" + result.RootCreated +
                " job_created=" + result.JobCreated + " process_created=" + result.ProcessCreated +
                " process_resumed=" + result.ProcessResumed + " job_empty_confirmed=" + result.JobEmptyConfirmed +
                " cleanup_safe=" + result.CleanupSafe +
                " forced=" + result.Forced + " exit_code=" + result.ExitCode);
            return result;
        }

        private static uint SafeActiveCount(IntPtr job)
        {
            try { return ActiveProcessCount(job); }
            catch { return UInt32.MaxValue; }
        }

        public static bool WaitForJobEmpty(IntPtr job, int timeoutMilliseconds)
        {
            Stopwatch watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < timeoutMilliseconds)
            {
                if (ActiveProcessCount(job) == 0) return true;
                Thread.Sleep(50);
            }
            return ActiveProcessCount(job) == 0;
        }

        private static string QuoteArgument(string value)
        {
            if (value == null) return "\"\"";
            StringBuilder result = new StringBuilder();
            result.Append('"');
            int slashes = 0;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c == '\\') { slashes++; continue; }
                if (c == '"')
                {
                    result.Append('\\', (slashes * 2) + 1).Append('"');
                    slashes = 0;
                    continue;
                }
                result.Append('\\', slashes).Append(c);
                slashes = 0;
            }
            result.Append('\\', slashes * 2).Append('"');
            return result.ToString();
        }

        private static uint[] GetJobProcessIds(IntPtr job)
        {
            return ProcessIds(job);
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("Self-test failed: " + message);
            Console.WriteLine("PASS supervisor self-test: " + message);
        }

        private static string MakeCmdArguments(string command)
        {
            // cmd /s strips the enclosing quotes. Keep the command's internal
            // quotes literal rather than applying native argv escaping to them.
            return "/d /s /c \"" + command + "\"";
        }

        private static IntPtr CreateTestJob()
        {
            IntPtr job = CreateJob();
            if (SelfTestJobs != null) SelfTestJobs.Add(job);
            return job;
        }

        private static NativeChild TrackTestChild(NativeChild child)
        {
            if (SelfTestChildren != null) SelfTestChildren.Add(child);
            return child;
        }

        private static string CreateSelfTestRoot()
        {
            string root = CreateOwnedTempRoot();
            if (SelfTestRoots != null) SelfTestRoots.Add(root);
            return root;
        }

        private static void DeleteSelfTestRoot(string root)
        {
            if (!TryDeleteOwnedRoot(root, true, false))
                throw new InvalidOperationException("A self-test root was not deleted after its cleanup condition was confirmed.");
            if (SelfTestRoots != null) SelfTestRoots.Remove(root);
        }

        private static void CloseTestChild(NativeChild child)
        {
            CloseNativeChild(child);
            if (SelfTestChildren != null) SelfTestChildren.Remove(child);
        }

        private static void CloseTestJob(IntPtr job)
        {
            CloseJob(job);
            if (SelfTestJobs != null) SelfTestJobs.Remove(job);
        }

        private static NativeChild StartProbe(IntPtr job, string command)
        {
            string cmd = GetSystemCommandProcessor();
            NativeChild child = TrackTestChild(CreateSuspendedInJob(job, cmd, MakeCmdArguments(command), Environment.CurrentDirectory, null));
            if (!IsMember(child.ProcessHandle, job))
            {
                if (!TerminateExactProcess(child, 1) || !WaitProcess(child.ProcessHandle, 5000))
                    throw new InvalidOperationException("A membership-rejected self-test probe could not be stopped.");
                CloseTestChild(child);
                throw new InvalidOperationException("Self-test probe was not assigned before resume.");
            }
            Resume(child);
            return child;
        }

        private static IntPtr OpenWaitHandle(uint processId)
        {
            IntPtr handle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (handle == IntPtr.Zero) throw Win32Error("OpenProcess failed for a PID created by the self-test.");
            return handle;
        }

        private static void WaitChildExit(NativeChild child, string label)
        {
            if (!WaitProcess(child.ProcessHandle, 15000))
                throw new TimeoutException("Self-test process did not exit: " + label);
        }

        private static NativeChild StartNativeProbe(IntPtr job, string application, string arguments,
            IDictionary<string, string> environment)
        {
            NativeChild child = TrackTestChild(CreateSuspendedInJob(
                job, application, arguments, Environment.CurrentDirectory, environment));
            if (!IsMember(child.ProcessHandle, job))
            {
                if (!TerminateExactProcess(child, 1) || !WaitProcess(child.ProcessHandle, 5000))
                    throw new InvalidOperationException("A membership-rejected self-test process could not be stopped.");
                CloseTestChild(child);
                throw new InvalidOperationException("A self-test process was not assigned to its exact Job before resume.");
            }
            Assert(WaitForSingleObject(child.ProcessHandle, 0) == WAIT_TIMEOUT,
                "the probe has not exited before its initial thread is resumed");
            Resume(child);
            return child;
        }

        private static ProcessResult RunInjectedFailure(string powershellPath, string root, SelfTestFaults faults,
            int timeoutMilliseconds, int gracefulMilliseconds, int terminationMilliseconds)
        {
            ActiveSelfTestFaults = faults;
            try
            {
                return Run(powershellPath, "-NoProfile -Command \"while ($true) { Start-Sleep -Milliseconds 1000 }\"",
                    Environment.CurrentDirectory, root, timeoutMilliseconds, gracefulMilliseconds,
                    terminationMilliseconds, faults.FailSignalRead);
            }
            finally { ActiveSelfTestFaults = null; }
        }

        private static void CloseCapturedProcessHandle(SelfTestFaults faults)
        {
            if (faults.CapturedProcessHandle == IntPtr.Zero) return;
            uint wait = WaitForSingleObject(faults.CapturedProcessHandle, 0);
            if (wait == WAIT_TIMEOUT)
            {
                Console.Error.WriteLine("[sql-supervisor-test] process-wait-handle-retained pid-still-active");
                return;
            }
            if (wait != WAIT_OBJECT_0) throw Win32Error("WaitForSingleObject(self-test process handle) failed.");
            if (!CloseHandle(faults.CapturedProcessHandle))
                throw Win32Error("CloseHandle(self-test process wait handle) failed.");
            faults.CapturedProcessHandle = IntPtr.Zero;
        }

        private static void WaitCapturedProcessExit(SelfTestFaults faults, string label)
        {
            if (faults.CapturedProcessHandle == IntPtr.Zero)
                throw new InvalidOperationException("The self-test did not retain a wait handle for " + label + ".");
            try
            {
                if (!WaitProcess(faults.CapturedProcessHandle, 10000))
                    throw new TimeoutException("The exact Run-owned process did not exit: " + label);
            }
            finally { CloseCapturedProcessHandle(faults); }
        }

        private static void RunCreationAndCleanupStateTests(string powershellPath)
        {
            string root = CreateSelfTestRoot();
            SelfTestFaults faults = new SelfTestFaults();
            faults.FailCreateJob = true;
            ProcessResult result = RunInjectedFailure(powershellPath, root, faults, 1000, 100, 100);
            Assert(result.RootCreated && !result.JobCreated && !result.ProcessCreated && result.CleanupSafe,
                "Job creation failure before any process permits deletion of this execution's root");
            DeleteSelfTestRoot(root);

            root = CreateSelfTestRoot();
            faults = new SelfTestFaults();
            faults.FailInstallControlHandler = true;
            result = RunInjectedFailure(powershellPath, root, faults, 1000, 100, 100);
            Assert(result.RootCreated && !result.JobCreated && !result.ProcessCreated && result.CleanupSafe,
                "control-handler installation failure before a Job or process permits root cleanup");
            DeleteSelfTestRoot(root);

            root = CreateSelfTestRoot();
            faults = new SelfTestFaults();
            faults.FailCreateProcess = true;
            result = RunInjectedFailure(powershellPath, root, faults, 1000, 100, 100);
            Assert(result.JobCreated && !result.ProcessCreated && result.JobEmptyConfirmed && result.CleanupSafe,
                "a created Job with no process is cleaned only after an empty-state query");
            Assert(faults.ActiveProcessQueryCount >= 2,
                "the no-process cleanup path queried the Job before authorizing deletion");
            Assert(Directory.Exists(root), "Run returns ownership decision without deleting the supervisor root");
            DeleteSelfTestRoot(root);

            root = CreateSelfTestRoot();
            faults = new SelfTestFaults { FailResume = true, CaptureProcessHandle = true };
            try
            {
                result = RunInjectedFailure(powershellPath, root, faults, 1000, 100, 3000);
                Assert(result.ProcessCreated && !result.ProcessResumed && result.ExitCode != 0 &&
                    result.JobEmptyConfirmed && result.CleanupSafe &&
                    result.Detail.Contains("Injected ResumeThread failure"),
                    "injected resume failure leaves the child suspended and confirms cleanup before deletion");
                WaitCapturedProcessExit(faults, "injected resume failure");
                DeleteSelfTestRoot(root);
            }
            finally { CloseCapturedProcessHandle(faults); }

            root = CreateSelfTestRoot();
            faults = new SelfTestFaults { FailSignalRead = true };
            result = RunInjectedFailure(powershellPath, root, faults, 1000, 100, 3000);
            Assert(result.ExitCode != 0 && result.JobEmptyConfirmed && result.CleanupSafe,
                "injected control channel read error forces a failing outcome with confirmed cleanup");
            DeleteSelfTestRoot(root);
        }

        private static void RunFailedJobAssignmentTest()
        {
            string root = CreateSelfTestRoot();
            string marker = Path.Combine(root, "invalid-job-command-ran.marker");
            string command = GetSystemCommandProcessor();
            IntPtr closedJob = CreateJob();
            CloseJob(closedJob);
            NativeChild unexpected = null;
            bool failedBeforeCreate = false;
            try
            {
                unexpected = TrackTestChild(CreateSuspendedInJob(closedJob, command,
                    MakeCmdArguments("echo SHOULD_NOT_RUN>" + QuoteArgument(marker)),
                    Environment.CurrentDirectory, null));
            }
            catch (Exception) { failedBeforeCreate = true; }
            if (unexpected != null)
            {
                if (!TerminateExactProcess(unexpected, 1) || !WaitProcess(unexpected.ProcessHandle, 5000))
                    throw new InvalidOperationException("An unexpected invalid-assignment probe could not be stopped.");
                CloseTestChild(unexpected);
            }
            Assert(failedBeforeCreate, "invalid Job assignment aborts process creation");
            Assert(!File.Exists(marker), "a command with invalid Job assignment never executes");
            DeleteSelfTestRoot(root);
        }

        private static void RunProcessIsolationTest()
        {
            string ping = GetSystemExecutable("ping.exe");
            ProcessStartInfo externalInfo = new ProcessStartInfo();
            externalInfo.FileName = ping;
            externalInfo.Arguments = "-n 15 127.0.0.1";
            externalInfo.UseShellExecute = false;
            externalInfo.CreateNoWindow = false;
            Process external = Process.Start(externalInfo);
            if (external == null) throw new InvalidOperationException("Could not start the self-test-owned outside process.");
            IntPtr job = CreateTestJob();
            NativeChild child = null;
            try
            {
                child = StartProbe(job, QuoteArgument(ping) + " -n 30 127.0.0.1 >nul");
                if (!TerminateJob(job, 1)) throw Win32Error("Could not terminate the self-test-owned Job.");
                Assert(WaitProcess(child.ProcessHandle, 10000), "the process created in the test Job exits when that Job is terminated");
                CloseTestChild(child);
                child = null;
                Assert(WaitForJobEmpty(job, 10000), "terminating the test Job confirms ActiveProcesses zero");
                Assert(!external.HasExited, "Job termination leaves a separately created process untouched");
                CloseTestJob(job);
            }
            finally
            {
                if (child != null && child.ProcessHandle != IntPtr.Zero)
                {
                    if (SafeActiveCount(job) != 0) TerminateJob(job, 1);
                    if (WaitProcess(child.ProcessHandle, 10000)) CloseTestChild(child);
                }
                if (SelfTestJobs != null && SelfTestJobs.Contains(job))
                {
                    if (SafeActiveCount(job) == 0) CloseTestJob(job);
                }
                try
                {
                    if (!external.HasExited)
                    {
                        external.Kill();
                        if (!external.WaitForExit(5000))
                            throw new TimeoutException("The self-test-owned outside process did not exit after termination.");
                    }
                }
                finally { external.Dispose(); }
            }
        }

        private static void RunDescendantContainmentTest()
        {
            string root = CreateSelfTestRoot();
            string ping = GetSystemExecutable("ping.exe");
            IntPtr job = CreateTestJob();
            NativeChild child = null;
            try
            {
                child = StartProbe(job, QuoteArgument(ping) + " -n 15 127.0.0.1 >nul");
                Stopwatch wait = Stopwatch.StartNew();
                uint[] processIds = new uint[0];
                while (wait.ElapsedMilliseconds < 5000)
                {
                    processIds = GetJobProcessIds(job);
                    if (processIds.Length >= 2) break;
                    Thread.Sleep(50);
                }
                Assert(processIds.Length >= 2, "a process launched by a Job member is counted in the same Job");
                for (int i = 0; i < processIds.Length; i++)
                {
                    IntPtr member = OpenWaitHandle(processIds[i]);
                    try { Assert(IsMember(member, job), "each enumerated descendant belongs to the exact Job"); }
                    finally
                    {
                        if (!CloseHandle(member)) throw Win32Error("CloseHandle(descendant probe) failed.");
                    }
                }
                Assert(!CanDeleteRoot(false, false), "root deletion is denied while Job emptiness is unconfirmed");
                Assert(!TryDeleteOwnedRoot(root, false, false) && Directory.Exists(root),
                    "an active Job does not permit root deletion");
                if (!TerminateJob(job, 1)) throw Win32Error("Could not terminate the descendant containment Job.");
                Assert(WaitProcess(child.ProcessHandle, 10000), "Job termination stops its initial process");
                CloseTestChild(child);
                child = null;
                Assert(WaitForJobEmpty(job, 10000), "Job termination confirms all descendants have exited");
                CloseTestJob(job);
                DeleteSelfTestRoot(root);
            }
            finally
            {
                if (child != null && child.ProcessHandle != IntPtr.Zero)
                {
                    if (SafeActiveCount(job) != 0) TerminateJob(job, 1);
                    if (WaitProcess(child.ProcessHandle, 10000)) CloseTestChild(child);
                }
                if (SelfTestJobs != null && SelfTestJobs.Contains(job) && SafeActiveCount(job) == 0)
                    CloseTestJob(job);
            }
        }

        private static void RunFailureRetentionTests(string powershellPath)
        {
            string root = CreateSelfTestRoot();
            SelfTestFaults faults = new SelfTestFaults();
            faults.FailTerminateJob = true;
            faults.CaptureProcessHandle = true;
            ProcessResult result = RunInjectedFailure(powershellPath, root, faults, 250, 100, 150);
            try
            {
                Assert(result.ProcessCreated && result.ProcessResumed && result.Forced &&
                    !result.JobEmptyConfirmed && !result.CleanupSafe && Directory.Exists(root),
                    "Run retains its root when TerminateJobObject fails and Job emptiness is unconfirmed");
                WaitCapturedProcessExit(faults, "TerminateJobObject failure probe");
                DeleteSelfTestRoot(root);
            }
            finally { CloseCapturedProcessHandle(faults); }

            root = CreateSelfTestRoot();
            faults = new SelfTestFaults();
            faults.FailActiveProcessQueries = true;
            faults.ActiveQueriesBeforeFailure = 1;
            faults.CaptureProcessHandle = true;
            result = RunInjectedFailure(powershellPath, root, faults, 30000, 100, 300);
            try
            {
                Assert(result.ProcessCreated && result.ProcessResumed && !result.JobEmptyConfirmed &&
                    !result.CleanupSafe && Directory.Exists(root),
                    "Run reaches Job-state query error handling and retains its root");
                Assert(faults.ActiveProcessQueryCount >= 3,
                    "the injected state-query failure occurs after launch and is retried only for bounded cleanup");
                WaitCapturedProcessExit(faults, "Job-state query failure probe");
                DeleteSelfTestRoot(root);
            }
            finally { CloseCapturedProcessHandle(faults); }
        }

        private static SignalProbeSession StartSignalProbe(string supervisorScript, string powershellPath, bool ignore,
            int timeoutMilliseconds, int gracefulMilliseconds = 350)
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = powershellPath;
            info.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
                QuoteArgument(supervisorScript) + " -SignalProbe -SignalProbeMode " +
                (ignore ? "ignore" : "normal") +
                " -SignalTimeoutMilliseconds " + timeoutMilliseconds +
                " -SignalGracefulMilliseconds " + gracefulMilliseconds + " -SignalTerminationMilliseconds 3000";
            info.UseShellExecute = false;
            info.CreateNoWindow = false;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            ProbeOutputCapture output = new ProbeOutputCapture();
            Process process = new Process();
            process.StartInfo = info;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            { if (eventArgs.Data != null) output.Append(eventArgs.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            { if (eventArgs.Data != null) output.Append(eventArgs.Data); };
            if (!process.Start()) throw new InvalidOperationException("Could not start the real signal-pipe probe.");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            return new SignalProbeSession(process, output);
        }

        private static void CheckSignalProbe(SignalProbeSession session, int expectedExit, bool forced,
            string firstSignalMarker, bool requireTerminationCall, int exitTimeoutMilliseconds = 20000)
        {
            session.ExpectMarker(firstSignalMarker, 10000, "signal event enters the central Run shutdown path");
            if (!session.WaitForExit(exitTimeoutMilliseconds))
                throw new TimeoutException("The real signal-pipe probe did not exit within its bounded timeout." +
                    Environment.NewLine + session.Output);
            string output = session.Output;
            Assert(session.ExitCode == expectedExit, "real signal-pipe probe preserves its required exit code");
            Assert(output.IndexOf("job_empty=True cleanup_safe=True", StringComparison.OrdinalIgnoreCase) >= 0,
                "real signal-pipe probe confirms Job emptiness before root cleanup");
            Assert(output.IndexOf("signal-probe-result", StringComparison.Ordinal) <
                output.IndexOf("signal-probe-root-removed job_empty_confirmed=true", StringComparison.Ordinal),
                "probe root is removed only after the result reports an empty Job");
            int terminateCalls = CountOccurrences(output, "TerminateJobObject requested");
            Assert((terminateCalls > 0) == requireTerminationCall,
                (requireTerminationCall ? "forced signal path uses the central TerminateJobObject path" :
                "ordered signal path exits without forced Job termination") + Environment.NewLine + output);
            Assert(output.IndexOf("forced=" + forced, StringComparison.OrdinalIgnoreCase) >= 0,
                "signal probe reports the expected graceful or forced result");
        }

        private static int CountOccurrences(string value, string token)
        {
            int count = 0;
            int offset = 0;
            while (value != null && (offset = value.IndexOf(token, offset, StringComparison.Ordinal)) >= 0)
            {
                count++;
                offset += token.Length;
            }
            return count;
        }

        private static void RunRealSignalPipeTests(string supervisorScript, string powershellPath)
        {
            using (SignalProbeSession session = StartSignalProbe(supervisorScript, powershellPath, false, 90000, 5000))
            {
                session.ExpectMarker("signal-pipe-ready", 30000, "signal probe startup");
                session.ExpectMarker("worker-stdin-eof", 60000,
                    "worker stdin reaches EOF while the supervisor signal channel is still open");
                session.Send(149);
                CheckSignalProbe(session, 149, false,
                    "first-signal-forwarding-ctrl-break", false);
                Assert(session.Output.Contains("worker-ctrl-break-received"),
                    "the worker confirms receipt of Ctrl+Break before exiting");
            }

            using (SignalProbeSession session = StartSignalProbe(supervisorScript, powershellPath, true, 90000))
            {
                session.ExpectMarker("signal-pipe-ready", 30000, "second-signal probe startup");
                session.ExpectMarker("worker-stdin-eof", 60000, "second-signal probe handler is installed");
                session.Send(149);
                Assert(session.WaitFor("first-signal-forwarding-ctrl-break", 10000),
                    "first real signal begins graceful termination");
                session.Send(149);
                CheckSignalProbe(session, 149, true,
                    "second-signal-forced-termination", true);
            }

            using (SignalProbeSession session = StartSignalProbe(supervisorScript, powershellPath, true, 90000))
            {
                session.ExpectMarker("signal-pipe-ready", 30000, "EOF probe startup");
                session.ExpectMarker("worker-stdin-eof", 60000, "EOF probe worker has installed its Ctrl+Break handler");
                session.CloseSignalChannel();
                CheckSignalProbe(session, 1, true,
                    "launcher-eof-forwarding-ctrl-break", true);
            }

            using (SignalProbeSession session = StartSignalProbe(supervisorScript, powershellPath, true, 90000, 5000))
            {
                session.ExpectMarker("signal-pipe-ready", 30000, "combined-event probe startup");
                session.ExpectMarker("worker-stdin-eof", 60000, "combined-event probe worker has installed its Ctrl+Break handler");
                session.Send(149);
                Assert(session.WaitFor("first-signal-forwarding-ctrl-break", 10000),
                    "combined-event probe processes its first real signal");
                session.CloseSignalChannel();
                CheckSignalProbe(session, 1, true,
                    "launcher-eof-forced-termination", true);
                Assert(CountOccurrences(session.Output, "TerminateJobObject requested") == 1,
                    "EOF concurrent with a signal converges on exactly one forced-termination request");
            }

            using (SignalProbeSession session = StartSignalProbe(supervisorScript, powershellPath, true, 750))
            {
                session.ExpectMarker("signal-pipe-ready", 30000, "timeout probe startup");
                CheckSignalProbe(session, 1, true,
                    "TerminateJobObject requested", true);
            }

            // The child compiles the helper before it can deliberately ignore Ctrl+Break.
            // Leave time for that startup and make the overall deadline precede the grace deadline.
            using (SignalProbeSession session = StartSignalProbe(supervisorScript, powershellPath, true, 70000, 80000))
            {
                session.ExpectMarker("worker-stdin-eof", 60000, "EOF and timeout probe worker has installed its Ctrl+Break handler");
                session.CloseSignalChannel();
                bool closedWriteRejected = false;
                try { session.Send(149); }
                catch (ObjectDisposedException) { closedWriteRejected = true; }
                Assert(closedWriteRejected, "a write after closing the probe control stream is rejected");
                CheckSignalProbe(session, 1, true, "launcher-eof-forwarding-ctrl-break", true, 80000);
                Assert(session.Output.Contains("worker-timeout") &&
                    CountOccurrences(session.Output, "TerminateJobObject requested") == 1,
                    "EOF followed by the overall deadline uses one termination path");
            }
        }

        public static void RunSelfTests(string supervisorScript, string powershellPath)
        {
            EnsureWindows10OrNewer();
            SelfTestJobs = new List<IntPtr>();
            SelfTestChildren = new List<NativeChild>();
            SelfTestRoots = new List<string>();
            Exception testError = null;
            List<Exception> cleanupErrors = new List<Exception>();
            try
            {
                IntPtr job = CreateTestJob();
                Assert(!IsJobHandleInheritable(job), "Job handle is non-inheritable");
                uint limits = QueryJobLimits(job).BasicLimitInformation.LimitFlags;
                Assert((limits & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) != 0 &&
                    (limits & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) == 0,
                    "Job uses kill-on-close and does not permit breakaway");
                Assert(ActiveProcessCount(job) == 0, "new Job starts with zero ActiveProcesses");

                NativeChild normal = StartNativeProbe(job, GetSystemCommandProcessor(),
                    MakeCmdArguments("exit 37"), null);
                Assert(IsMember(normal.ProcessHandle, job), "initial process belongs to the exact Job before resume");
                Assert(WaitProcess(normal.ProcessHandle, 5000) && ExitCode(normal.ProcessHandle) == 37, "normal process exit code is preserved");
                CloseTestChild(normal);
                Assert(WaitForJobEmpty(job, 5000), "normal process exit yields ActiveProcesses zero");
                CloseTestJob(job);

                RunFailedJobAssignmentTest();
                RunProcessIsolationTest();
                RunDescendantContainmentTest();
                RunCreationAndCleanupStateTests(powershellPath);
                RunFailureRetentionTests(powershellPath);
                RunRealSignalPipeTests(supervisorScript, powershellPath);
                string crashStatusRoot = CreateSelfTestRoot();
                RunCrashCloseSelfTest(supervisorScript, powershellPath, crashStatusRoot);
                DeleteSelfTestRoot(crashStatusRoot);
                Console.WriteLine("PASS supervisor self-tests completed; SQL migrations were not run by the self-test probes");
            }
            catch (Exception error) { testError = error; }
            finally
            {
                for (int i = 0; i < SelfTestJobs.Count; i++)
                {
                    IntPtr ownedJob = SelfTestJobs[i];
                    try
                    {
                        uint active = ActiveProcessCount(ownedJob);
                        if (active != 0 && !TerminateJob(ownedJob, 1))
                            throw new InvalidOperationException("Could not terminate a self-test-owned Job.");
                    }
                    catch (Exception error) { cleanupErrors.Add(error); }
                }
                for (int i = 0; i < SelfTestChildren.Count; i++)
                {
                    NativeChild ownedChild = SelfTestChildren[i];
                    try
                    {
                        if (ownedChild.ProcessHandle != IntPtr.Zero && !WaitProcess(ownedChild.ProcessHandle, 0))
                        {
                            if (!TerminateExactProcess(ownedChild, 1))
                                throw Win32Error("Could not stop an exact self-test-owned process during cleanup.");
                        }
                        if (ownedChild.ProcessHandle != IntPtr.Zero && !WaitProcess(ownedChild.ProcessHandle, 10000))
                            throw new TimeoutException("A self-test-owned process did not exit.");
                    }
                    catch (Exception error) { cleanupErrors.Add(error); }
                    try { CloseNativeChild(ownedChild); }
                    catch (Exception error) { cleanupErrors.Add(error); }
                }
                for (int i = 0; i < SelfTestJobs.Count; i++)
                {
                    IntPtr ownedJob = SelfTestJobs[i];
                    try
                    {
                        if (ActiveProcessCount(ownedJob) != 0)
                            throw new InvalidOperationException("A self-test Job remained nonempty before its handle was closed.");
                    }
                    catch (Exception error) { cleanupErrors.Add(error); }
                    try { CloseJob(ownedJob); }
                    catch (Exception error) { cleanupErrors.Add(error); }
                }
                SelfTestChildren = null;
                SelfTestJobs = null;
                ActiveSelfTestFaults = null;

                foreach (string root in SelfTestRoots)
                {
                    Console.Error.WriteLine("[sql-supervisor-test] root-retained path=" + root + " reason=cleanup-was-not-explicitly-confirmed");
                    cleanupErrors.Add(new IOException("A self-test root remains because its cleanup precondition was not explicitly confirmed: " + root));
                }
                SelfTestRoots = null;
            }
            if (cleanupErrors.Count > 0)
            {
                if (testError != null) cleanupErrors.Insert(0, testError);
                throw new AggregateException("Supervisor self-test or cleanup failed.", cleanupErrors);
            }
            if (testError != null) ExceptionDispatchInfo.Capture(testError).Throw();
        }

        private static void RunCrashCloseSelfTest(string supervisorScript, string powershellPath, string root)
        {
            string status = Path.Combine(root, "crash-probe.status");
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = powershellPath;
            info.Arguments = "-NoProfile -File " + QuoteArgument(supervisorScript) + " -CrashProbe -CrashProbeStatus " + QuoteArgument(status);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            Process probe = Process.Start(info);
            if (probe == null) throw new InvalidOperationException("Could not launch the isolated crash-closure supervisor probe.");
            probe.BeginOutputReadLine();
            probe.BeginErrorReadLine();
            try
            {
                Stopwatch wait = Stopwatch.StartNew();
                while (!File.Exists(status) && wait.ElapsedMilliseconds < 10000)
                {
                    if (probe.HasExited) throw new InvalidOperationException("Crash probe exited before creating its Job child.");
                    Thread.Sleep(50);
                }
                if (!File.Exists(status)) throw new TimeoutException("Crash probe did not publish its owned worker PID.");
                string[] fields = File.ReadAllText(status).Split('|');
                if (fields.Length != 2) throw new InvalidDataException("Crash probe status is malformed.");
                uint workerId = UInt32.Parse(fields[0]);
                IntPtr worker = OpenWaitHandle(workerId);
                try
                {
                    probe.Kill();
                    if (!probe.WaitForExit(10000)) throw new TimeoutException("Crash-probe supervisor did not exit.");
                    uint waitResult = WaitForSingleObject(worker, 10000);
                    Assert(waitResult == WAIT_OBJECT_0, "abrupt supervisor termination closes last Job handle and kills child");
                    Assert(Directory.Exists(fields[1]), "abrupt close leaves the temp root for manual cleanup");
                    Console.WriteLine("[sql-supervisor-test] crash-probe-root-retained path=" +
                        fields[1] + " reason=job-empty-could-not-be-queried-after-abrupt-close");
                }
                finally
                {
                    if (!CloseHandle(worker)) throw Win32Error("CloseHandle(crash-probe worker wait handle) failed.");
                }
            }
            finally
            {
                try
                {
                    if (!probe.HasExited)
                    {
                        probe.Kill();
                        if (!probe.WaitForExit(5000))
                            throw new TimeoutException("The crash-probe supervisor did not exit after fallback termination.");
                    }
                }
                finally { probe.Dispose(); }
            }
        }

        public static void CrashProbe(string statusPath)
        {
            string root = CreateOwnedTempRoot();
            IntPtr job = IntPtr.Zero;
            NativeChild child = null;
            bool statusPublished = false;
            bool safeToDeleteRoot = true;
            try
            {
                job = CreateJob();
                string ping = GetSystemExecutable("ping.exe");
                child = CreateSuspendedInJob(job, ping, "-n 120 127.0.0.1",
                    Environment.CurrentDirectory, null);
                if (!IsMember(child.ProcessHandle, job))
                    throw new InvalidOperationException("Crash probe process was not assigned to its Job.");
                // Publish the exact, already-assigned process before it can run so
                // the parent can still prove exit if this supervisor is terminated.
                File.WriteAllText(statusPath, child.ProcessId.ToString() + "|" + root);
                statusPublished = true;
                Resume(child);
                Thread.Sleep(Timeout.Infinite);
            }
            finally
            {
                if (!statusPublished)
                {
                    if (job != IntPtr.Zero)
                    {
                        if (SafeActiveCount(job) != 0 && !TerminateJob(job, 1)) safeToDeleteRoot = false;
                        if (child != null && child.ProcessHandle != IntPtr.Zero &&
                            !WaitProcess(child.ProcessHandle, 10000)) safeToDeleteRoot = false;
                        if (child != null) CloseNativeChild(child);
                        if (SafeActiveCount(job) != 0) safeToDeleteRoot = false;
                        try { CloseJob(job); }
                        catch { safeToDeleteRoot = false; }
                    }
                    if (safeToDeleteRoot)
                    {
                        try
                        {
                            if (!TryDeleteOwnedRoot(root, true, false)) safeToDeleteRoot = false;
                        }
                        catch { safeToDeleteRoot = false; }
                    }
                    if (!safeToDeleteRoot && Directory.Exists(root))
                        Console.Error.WriteLine("[sql-supervisor-test] crash-probe root retained because Job emptiness was not confirmed");
                }
            }
        }
    }
}

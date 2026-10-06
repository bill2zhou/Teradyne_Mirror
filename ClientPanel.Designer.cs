namespace WinFormSocketClient
{
    partial class ClientPanel
    {
        /// <summary> 
        /// 必需的设计器变量。
        /// </summary>
        private System.ComponentModel.IContainer components = null;

        /// <summary> 
        /// 清理所有正在使用的资源。
        /// </summary>
        /// <param name="disposing">如果应释放托管资源，为 true；否则为 false。</param>
        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        #region 组件设计器生成的代码

        /// <summary> 
        /// 设计器支持所需的方法 - 不要修改
        /// 使用代码编辑器修改此方法的内容。
        /// </summary>
        private void InitializeComponent()
        {
            this.rtbLog = new System.Windows.Forms.RichTextBox();
            this.lblConnectionInfo = new System.Windows.Forms.Label();
            this.SuspendLayout();
            // 
            // rtbLog
            // 
            this.rtbLog.Dock = System.Windows.Forms.DockStyle.Fill;
            this.rtbLog.Font = new System.Drawing.Font("Consolas", 9F, System.Drawing.FontStyle.Regular, System.Drawing.GraphicsUnit.Point, ((byte)(0)));
            this.rtbLog.Location = new System.Drawing.Point(0, 25);
            this.rtbLog.Name = "rtbLog";
            this.rtbLog.ReadOnly = true;
            this.rtbLog.Size = new System.Drawing.Size(800, 455);
            this.rtbLog.TabIndex = 0;
            this.rtbLog.Text = "";
            // 
            // lblConnectionInfo
            // 
            this.lblConnectionInfo.BackColor = System.Drawing.SystemColors.ControlLight;
            this.lblConnectionInfo.Dock = System.Windows.Forms.DockStyle.Top;
            this.lblConnectionInfo.Font = new System.Drawing.Font("Microsoft YaHei UI", 9F, System.Drawing.FontStyle.Bold, System.Drawing.GraphicsUnit.Point, ((byte)(134)));
            this.lblConnectionInfo.Location = new System.Drawing.Point(0, 0);
            this.lblConnectionInfo.Name = "lblConnectionInfo";
            this.lblConnectionInfo.Padding = new System.Windows.Forms.Padding(5, 0, 0, 0);
            this.lblConnectionInfo.Size = new System.Drawing.Size(800, 25);
            this.lblConnectionInfo.TabIndex = 3;
            this.lblConnectionInfo.Text = "当前连接: -";
            this.lblConnectionInfo.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
            // 
            // ClientPanel
            // 
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 12F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.Controls.Add(this.rtbLog);
            this.Controls.Add(this.lblConnectionInfo);
            this.Name = "ClientPanel";
            this.Size = new System.Drawing.Size(800, 480);
            this.ResumeLayout(false);

        }

        #endregion

        private System.Windows.Forms.RichTextBox rtbLog;
        private System.Windows.Forms.Label lblConnectionInfo;
    }
}